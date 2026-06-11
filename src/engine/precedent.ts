/**
 * The compounding loop — every engagement makes the next one smarter.
 *
 * Three things become precedent automatically: comment resolutions a lawyer
 * accepted or edited, clauses from executed side letters you upload, and
 * draft sections revised under lawyer feedback. Each carries a weight —
 * human-edited language weighs more than machine language a human merely
 * accepted — and every time a precedent informs a new suggestion its weight
 * compounds a little. Retrieval ranks by relevance × earned weight, so the
 * firm's actual decisions, not just its documents, shape the next answer.
 */

import type Database from 'better-sqlite3';
import { genId } from '../db/db.js';
import { embedAll, loadEmbeddings, cosine } from '../search/embeddings.js';
import { sanitizeFtsQuery } from '../search/hybrid.js';
import * as ollama from '../ai/ollama.js';

export type PrecedentKind = 'resolution' | 'side_letter_clause' | 'draft_section';

export interface Precedent {
  id: string;
  fund_id: string | null;
  kind: PrecedentKind;
  topic: string;
  title: string;
  text: string;
  source_type: string;
  source_id: string;
  weight: number;
  uses: number;
}

const MAX_WEIGHT = 2.0;

/**
 * Promote something a human stood behind into precedent. Re-promoting the
 * same source (e.g. a comment re-resolved) refreshes the text and bumps the
 * weight — repetition is endorsement.
 */
export async function promotePrecedent(
  db: Database.Database,
  opts: {
    kind: PrecedentKind;
    topic: string;
    title: string;
    text: string;
    sourceType: string;
    sourceId: string;
    fundId?: string | null;
    weight?: number;
  },
): Promise<Precedent> {
  const existing = db
    .prepare(`SELECT * FROM precedents WHERE source_type = ? AND source_id = ?`)
    .get(opts.sourceType, opts.sourceId) as Precedent | undefined;

  let id: string;
  if (existing) {
    id = existing.id;
    db.prepare(`UPDATE precedents SET text = ?, title = ?, topic = ?, weight = MIN(?, weight + 0.2) WHERE id = ?`).run(
      opts.text,
      opts.title,
      opts.topic,
      MAX_WEIGHT,
      id,
    );
  } else {
    id = genId('prec');
    db.prepare(
      `INSERT INTO precedents (id, fund_id, kind, topic, title, text, source_type, source_id, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.fundId ?? null, opts.kind, opts.topic, opts.title, opts.text, opts.sourceType, opts.sourceId, opts.weight ?? 1.0);
  }

  await embedAll(db, [{ ownerType: 'precedent', ownerId: id, text: `${opts.title}\n${opts.text}` }]);
  return db.prepare(`SELECT * FROM precedents WHERE id = ?`).get(id) as Precedent;
}

export interface PrecedentHit extends Precedent {
  relevance: number;
  score: number;
}

/** Relevance × earned weight, with a small bonus for proven reuse. */
function effectiveScore(relevance: number, weight: number, uses: number): number {
  return relevance * (1 + 0.35 * (weight - 1)) * (1 + 0.04 * Math.min(uses, 10));
}

export async function searchPrecedents(
  db: Database.Database,
  opts: { query: string; topic?: string; topK?: number },
): Promise<PrecedentHit[]> {
  const topK = opts.topK ?? 3;
  const candidates = new Map<string, { row: Precedent; relevance: number }>();

  // keyword leg
  const ftsQuery = sanitizeFtsQuery(opts.query);
  if (ftsQuery) {
    try {
      const rows = db
        .prepare(
          `SELECT p.*, rank FROM precedents_fts f JOIN precedents p ON p.rowid = f.rowid
           WHERE precedents_fts MATCH ? ${opts.topic ? 'AND p.topic = ?' : ''} ORDER BY rank LIMIT ?`,
        )
        .all(...(opts.topic ? [ftsQuery, opts.topic, topK * 4] : [ftsQuery, topK * 4])) as Array<Precedent & { rank: number }>;
      // FTS5 bm25 rank is NEGATIVE and more negative = better — normalize
      // within the result set so the strongest match scores 1.0
      const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.rank)), 0) || 1;
      for (const r of rows) candidates.set(r.id, { row: r, relevance: Math.abs(r.rank) / maxAbs });
    } catch {
      /* fts syntax — fall through to semantic leg */
    }
  }

  // semantic leg (when Ollama is reachable)
  if (await ollama.isUp()) {
    try {
      const [queryVec] = await ollama.embed([opts.query]);
      const stored = loadEmbeddings(db, 'precedent');
      for (const [id, vec] of stored) {
        if (vec.length !== queryVec.length) continue;
        const sim = cosine(queryVec, vec);
        const existing = candidates.get(id);
        if (existing) {
          existing.relevance = 0.5 * existing.relevance + 0.5 * sim;
        } else if (sim > 0.4) {
          const row = db.prepare(`SELECT * FROM precedents WHERE id = ?`).get(id) as Precedent | undefined;
          if (row && (!opts.topic || row.topic === opts.topic)) candidates.set(id, { row, relevance: sim * 0.5 });
        }
      }
    } catch {
      /* keyword-only */
    }
  }

  const hits: PrecedentHit[] = [...candidates.values()].map(({ row, relevance }) => ({
    ...row,
    relevance,
    score: effectiveScore(relevance, row.weight, row.uses),
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** A precedent informed a new suggestion — its standing compounds. */
export function markPrecedentsUsed(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`UPDATE precedents SET uses = uses + 1, weight = MIN(?, weight + 0.05) WHERE id = ?`);
  for (const id of ids) stmt.run(MAX_WEIGHT, id);
}

export function listPrecedents(db: Database.Database, limit = 50): Precedent[] {
  return db
    .prepare(`SELECT * FROM precedents ORDER BY (weight * (1 + uses * 0.1)) DESC, created_at DESC LIMIT ?`)
    .all(limit) as Precedent[];
}

/** Format hits for a prompt block — quoted so citations can verify. */
export function precedentPromptBlock(hits: PrecedentHit[]): string {
  if (hits.length === 0) return '';
  const body = hits
    .map(
      (h) =>
        `[sourceType: precedent, sourceId: ${h.id}] (${h.kind.replace(/_/g, ' ')}, weight ${h.weight.toFixed(1)}, used ${h.uses}×) ${h.title}\n"${h.text}"`,
    )
    .join('\n\n');
  return `HOW THIS FIRM HAS RESOLVED SIMILAR GROUND BEFORE (house precedent — weight reflects lawyer acceptance and reuse; prefer higher-weight language):\n\n${body}`;
}
