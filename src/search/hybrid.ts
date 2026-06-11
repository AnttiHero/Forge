/**
 * Hybrid retrieval — FTS5 BM25 keyword search blended with cosine
 * similarity over local embeddings. Retrieval always runs locally on raw
 * (un-anonymized) data; nothing here leaves the machine.
 *
 * Degradation: no Ollama → no query embedding → pure BM25. FTS syntax
 * error → LIKE fallback.
 */

import type Database from 'better-sqlite3';
import * as ollama from '../ai/ollama.js';
import { cosine, loadEmbeddings } from './embeddings.js';

export interface SearchHit {
  id: string;
  heading: string;
  text: string;
  documentId: string;
  bm25: number;
  cosine: number | null;
  score: number;
}

export interface SearchOptions {
  query: string;
  table: 'provisions' | 'obligations';
  /** provisions: filter by topic */
  topic?: string;
  /** filter by owning fund (provisions join documents.fund_id) */
  fundId?: string;
  /** provisions: filter by document status ('model' = model library only) */
  docStatus?: string;
  /** provisions: filter by document type (e.g. 'side_letter') */
  docType?: string;
  topK?: number;
  /** Inject a query vector (tests). Production embeds via Ollama. */
  queryVector?: ArrayLike<number>;
}

/** Strip FTS5 operators, keep words from all scripts, OR-join. */
export function sanitizeFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/["\\-]/g, ''))
    .filter((w) => w.length >= 2);
  if (words.length === 0) return '';
  return [...new Set(words)].map((w) => `"${w}"`).join(' OR ');
}

interface RawRow {
  id: string;
  heading: string;
  text: string;
  documentId: string;
  rank: number;
}

function buildFilters(opts: SearchOptions): { joins: string; where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  let joins = '';
  if (opts.table === 'provisions') {
    joins = 'JOIN documents d ON d.id = t.document_id';
    if (opts.topic) {
      where.push('t.topic = ?');
      params.push(opts.topic);
    }
    if (opts.fundId) {
      where.push('d.fund_id = ?');
      params.push(opts.fundId);
    }
    if (opts.docStatus) {
      where.push('d.status = ?');
      params.push(opts.docStatus);
    }
    if (opts.docType) {
      where.push('d.type = ?');
      params.push(opts.docType);
    }
  } else {
    if (opts.fundId) {
      where.push('t.fund_id = ?');
      params.push(opts.fundId);
    }
  }
  return { joins, where, params };
}

function selectColumns(table: SearchOptions['table']): string {
  return table === 'provisions'
    ? `t.id AS id, t.heading AS heading, t.text AS text, t.document_id AS documentId`
    : `t.id AS id, t.summary AS heading, t.source_clause AS text, t.source_document_id AS documentId`;
}

function ftsSearch(db: Database.Database, ftsQuery: string, opts: SearchOptions, limit: number): RawRow[] {
  const fts = opts.table === 'provisions' ? 'provisions_fts' : 'obligations_fts';
  const { joins, where, params } = buildFilters(opts);
  const whereClause = where.length > 0 ? `AND ${where.join(' AND ')}` : '';
  const sql = `
    SELECT ${selectColumns(opts.table)}, rank
    FROM ${fts} f
    JOIN ${opts.table} t ON t.rowid = f.rowid
    ${joins}
    WHERE ${fts} MATCH ? ${whereClause}
    ORDER BY rank
    LIMIT ?
  `;
  return db.prepare(sql).all(ftsQuery, ...params, limit) as RawRow[];
}

function likeSearch(db: Database.Database, opts: SearchOptions, limit: number): RawRow[] {
  const { joins, where, params } = buildFilters(opts);
  const textCol = opts.table === 'provisions' ? 't.text' : 't.source_clause';
  const headCol = opts.table === 'provisions' ? 't.heading' : 't.summary';
  const escaped = opts.query.toLowerCase().replace(/[%_\\]/g, '\\$&');
  where.push(`(LOWER(${textCol}) LIKE ? ESCAPE '\\' OR LOWER(${headCol}) LIKE ? ESCAPE '\\')`);
  params.push(`%${escaped}%`, `%${escaped}%`);
  const sql = `
    SELECT ${selectColumns(opts.table)}, 0 AS rank
    FROM ${opts.table} t
    ${joins}
    WHERE ${where.join(' AND ')}
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit) as RawRow[];
}

function fetchByIds(db: Database.Database, opts: SearchOptions, ids: string[]): RawRow[] {
  if (ids.length === 0) return [];
  const { joins, where, params } = buildFilters(opts);
  where.push(`t.id IN (${ids.map(() => '?').join(',')})`);
  params.push(...ids);
  const sql = `
    SELECT ${selectColumns(opts.table)}, 0 AS rank
    FROM ${opts.table} t
    ${joins}
    WHERE ${where.join(' AND ')}
  `;
  return db.prepare(sql).all(...params) as RawRow[];
}

export async function hybridSearch(db: Database.Database, opts: SearchOptions): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const ftsQuery = sanitizeFtsQuery(opts.query);

  let keywordHits: RawRow[] = [];
  if (ftsQuery) {
    try {
      keywordHits = ftsSearch(db, ftsQuery, opts, topK * 3);
    } catch {
      keywordHits = likeSearch(db, opts, topK * 3);
    }
  }

  // Query embedding: injected (tests) or via Ollama; null when unavailable.
  let queryVec: ArrayLike<number> | null = opts.queryVector ?? null;
  if (!queryVec && (await ollama.isUp())) {
    try {
      const [vec] = await ollama.embed([opts.query]);
      queryVec = vec;
    } catch {
      queryVec = null;
    }
  }

  const cosineById = new Map<string, number>();
  if (queryVec) {
    const ownerType = opts.table === 'provisions' ? 'provision' : 'obligation';
    const stored = loadEmbeddings(db, ownerType);
    for (const [id, vec] of stored) {
      if (vec.length !== queryVec.length) continue;
      cosineById.set(id, cosine(queryVec, vec));
    }
  }

  // Candidates = BM25 hits ∪ top semantic hits
  const candidates = new Map<string, RawRow>();
  for (const row of keywordHits) candidates.set(row.id, row);
  if (cosineById.size > 0) {
    const semanticTop = [...cosineById.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK * 3)
      .map(([id]) => id)
      .filter((id) => !candidates.has(id));
    for (const row of fetchByIds(db, opts, semanticTop)) candidates.set(row.id, row);
  }

  // FTS5 bm25 rank is NEGATIVE and more negative = better — normalize by
  // the strongest match so the best keyword hit scores 1.0 (rank 0 means
  // "no bm25 signal": LIKE-fallback rows get 0.5, semantic-only rows 0)
  const maxAbsRank = keywordHits.reduce((m, r) => Math.max(m, Math.abs(r.rank)), 0) || 1;
  const hits: SearchHit[] = [...candidates.values()].map((row) => {
    const bm25 = row.rank !== 0 ? Math.abs(row.rank) / maxAbsRank : keywordHits.some((k) => k.id === row.id) ? 0.5 : 0;
    const cos = cosineById.has(row.id) ? cosineById.get(row.id)! : null;
    const score = cos !== null ? 0.5 * bm25 + 0.5 * cos : bm25;
    return { id: row.id, heading: row.heading, text: row.text, documentId: row.documentId, bm25, cosine: cos, score };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
