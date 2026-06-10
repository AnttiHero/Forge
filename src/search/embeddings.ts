/**
 * Embedding storage and similarity — vectors live as BLOBs beside the rows
 * they index; brute-force cosine is plenty at this corpus size.
 */

import type Database from 'better-sqlite3';
import { config } from '../config.js';
import * as ollama from '../ai/ollama.js';

export type OwnerType = 'provision' | 'comment' | 'obligation' | 'side_letter';

export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function storeEmbedding(
  db: Database.Database,
  ownerType: OwnerType,
  ownerId: string,
  vector: number[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (owner_type, owner_id, model, dims, vector) VALUES (?, ?, ?, ?, ?)`,
  ).run(ownerType, ownerId, config.ollama.embedModel, vector.length, vectorToBlob(vector));
}

/**
 * Embed and store a batch of rows. Returns the number stored; 0 when Ollama
 * is unreachable (search degrades to keyword-only).
 */
export async function embedAll(
  db: Database.Database,
  items: Array<{ ownerType: OwnerType; ownerId: string; text: string }>,
  batchSize = 16,
): Promise<number> {
  if (items.length === 0) return 0;
  if (!(await ollama.isUp())) return 0;
  let stored = 0;
  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const vectors = await ollama.embed(batch.map((b) => b.text));
      for (let j = 0; j < batch.length; j++) {
        storeEmbedding(db, batch[j].ownerType, batch[j].ownerId, vectors[j]);
        stored += 1;
      }
    }
  } catch {
    // Partial embeddings are fine — hybrid search blends what exists.
  }
  return stored;
}

/** Load all embeddings for an owner type, keyed by owner id. Filters out
 *  vectors from a different embedding model (dimension mismatch safety). */
export function loadEmbeddings(db: Database.Database, ownerType: OwnerType): Map<string, Float32Array> {
  const rows = db
    .prepare(`SELECT owner_id, model, vector FROM embeddings WHERE owner_type = ?`)
    .all(ownerType) as Array<{ owner_id: string; model: string; vector: Buffer }>;
  const map = new Map<string, Float32Array>();
  for (const row of rows) {
    if (row.model !== config.ollama.embedModel) continue;
    map.set(row.owner_id, blobToVector(row.vector));
  }
  return map;
}
