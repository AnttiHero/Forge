/**
 * Bring-your-own-document intake — the bridge from a real uploaded file to
 * the ontology. Create a matter (engagement), ingest documents into it as
 * provisions, and the rest of the engine (obligations, search, Q&A) works
 * on the user's own data exactly as it does on the seed corpus.
 */

import type Database from 'better-sqlite3';
import { genId } from '../db/db.js';
import { extractText, chunkIntoProvisions, guessDocType } from '../documents/parser.js';
import { embedAll } from '../search/embeddings.js';

export interface Matter {
  id: string;
  name: string;
  numeral: number;
  target_size_usd: number;
  strategy: string;
  status: string;
  vintage: number;
}

/** Create a real engagement the user owns. Stored as a fund row so every
 *  existing stage (obligations, comments, side letters) works against it. */
export function createMatter(
  db: Database.Database,
  opts: { name: string; strategy?: string; targetSizeUsd?: number; vintage?: number },
): Matter {
  const name = opts.name.trim();
  if (!name) throw new Error('Matter name is required');
  const id = genId('fund');
  db.prepare(
    `INSERT INTO funds (id, name, numeral, target_size_usd, strategy, status, vintage) VALUES (?, ?, 0, ?, ?, 'forming', ?)`,
  ).run(id, name, opts.targetSizeUsd ?? 0, opts.strategy ?? 'User engagement', opts.vintage ?? 0);
  return db.prepare(`SELECT * FROM funds WHERE id = ?`).get(id) as Matter;
}

export interface IngestResult {
  documentId: string;
  title: string;
  type: string;
  provisionCount: number;
  charCount: number;
  embedded: number;
}

/**
 * Parse an uploaded document, store it against a matter, and split it into
 * citable provisions. Returns enough for the UI to offer obligation
 * extraction next.
 */
export async function ingestDocument(
  db: Database.Database,
  opts: { fundId: string; buffer: Buffer; filename: string; mimeType: string; title?: string },
): Promise<IngestResult> {
  const fund = db.prepare(`SELECT id FROM funds WHERE id = ?`).get(opts.fundId) as { id: string } | undefined;
  if (!fund) throw new Error(`Unknown matter: ${opts.fundId}`);

  const text = (await extractText(opts.buffer, opts.filename, opts.mimeType)).trim();
  if (text.length < 40) {
    throw new Error('Could not read meaningful text from this document (is it a scanned image PDF?).');
  }

  const title = opts.title?.trim() || opts.filename.replace(/\.[^.]+$/, '');
  const docType = guessDocType(opts.filename, text);
  const provisions = chunkIntoProvisions(text);
  if (provisions.length === 0) throw new Error('No provisions could be identified in this document.');

  const documentId = genId('doc');
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, fund_id, type, status, title, content) VALUES (?, ?, ?, 'closed', ?, ?)`,
  );
  const insertProvision = db.prepare(
    `INSERT INTO provisions (id, document_id, topic, heading, text, position) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const provisionIds: Array<{ id: string; heading: string; text: string }> = [];
  const tx = db.transaction(() => {
    insertDoc.run(documentId, opts.fundId, docType, title, text);
    provisions.forEach((p, i) => {
      const pid = genId('p');
      insertProvision.run(pid, documentId, p.topic, p.heading, p.text, i + 1);
      provisionIds.push({ id: pid, heading: p.heading, text: p.text });
    });
  });
  tx();

  const embedded = await embedAll(
    db,
    provisionIds.map((p) => ({ ownerType: 'provision' as const, ownerId: p.id, text: `${p.heading}\n${p.text}` })),
  );

  return {
    documentId,
    title,
    type: docType,
    provisionCount: provisions.length,
    charCount: text.length,
    embedded,
  };
}
