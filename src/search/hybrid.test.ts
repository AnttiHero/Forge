import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { storeEmbedding, cosine, vectorToBlob, blobToVector } from './embeddings.js';
import { hybridSearch } from './hybrid.js';
import { resetHealthCache } from '../ai/ollama.js';

describe('hybrid search', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('vector blob roundtrip + cosine', () => {
    const v = [0.1, -0.5, 0.8];
    const back = blobToVector(vectorToBlob(v));
    expect([...back].map((x) => Math.round(x * 10) / 10)).toEqual(v);
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('keyword-only hit when Ollama is down (degraded path)', async () => {
    const hits = await hybridSearch(db, { query: 'sub-Saharan Africa obligations', table: 'obligations', topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.cosine === null)).toBe(true);
    expect(hits.map((h) => h.id)).toContain('obl-04');
  });

  it('semantic-only hit surfaces via injected query vector', async () => {
    // Give obl-19 (currency exposure) a vector aligned with the query; the
    // query words share nothing with the row text.
    storeEmbedding(db, 'obligation', 'obl-19', [1, 0, 0]);
    storeEmbedding(db, 'obligation', 'obl-16', [0, 1, 0]);
    const hits = await hybridSearch(db, {
      query: 'zzzunmatchable kwords',
      table: 'obligations',
      topK: 3,
      queryVector: [1, 0, 0],
    });
    expect(hits[0]?.id).toBe('obl-19');
    expect(hits[0]?.cosine).toBeCloseTo(1);
  });

  it('blends keyword and semantic scores (ordering)', async () => {
    // Both match keywords; vector pushes obl-02 above obl-01
    storeEmbedding(db, 'obligation', 'obl-01', [0, 1, 0]);
    storeEmbedding(db, 'obligation', 'obl-02', [1, 0, 0]);
    const hits = await hybridSearch(db, {
      query: 'sub-Saharan Africa',
      table: 'obligations',
      topK: 5,
      queryVector: [1, 0, 0],
    });
    const i01 = hits.findIndex((h) => h.id === 'obl-01');
    const i02 = hits.findIndex((h) => h.id === 'obl-02');
    expect(i02).toBeGreaterThanOrEqual(0);
    expect(i02).toBeLessThan(i01 === -1 ? hits.length : i01);
  });

  it('filters provisions to the model library', async () => {
    const hits = await hybridSearch(db, {
      query: 'management fee step down',
      table: 'provisions',
      docStatus: 'model',
      topK: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const doc = db.prepare(`SELECT status FROM documents WHERE id = ?`).get(h.documentId) as { status: string };
      expect(doc.status).toBe('model');
    }
  });

  it('falls back to LIKE on FTS syntax bombs', async () => {
    const hits = await hybridSearch(db, { query: 'NEAR( "" )', table: 'provisions', topK: 3 });
    expect(Array.isArray(hits)).toBe(true);
  });
});
