import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/db.js';
import { seedDatabase } from './seed.js';

describe('seed', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-seed-'));
    db = openDb(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the full Vulcan corpus with verified citations', async () => {
    const summary = await seedDatabase(db, { embeddings: false });
    expect(summary.funds).toBe(3);
    expect(summary.investors).toBe(14);
    expect(summary.obligations).toBe(21);
    expect(summary.unverifiedObligations).toEqual([]);

    const verified = db.prepare(`SELECT COUNT(*) AS n FROM obligations WHERE verified = 1`).get() as { n: number };
    expect(verified.n).toBe(21);
  });

  it('FTS finds the Africa obligations', async () => {
    await seedDatabase(db, { embeddings: false });
    const rows = db
      .prepare(`SELECT o.id FROM obligations_fts f JOIN obligations o ON o.rowid = f.rowid WHERE obligations_fts MATCH '"sub-Saharan" OR Africa'`)
      .all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('obl-01');
    expect(ids).toContain('obl-04');
  });

  it('is idempotent (re-seed wipes and reloads)', async () => {
    await seedDatabase(db, { embeddings: false });
    await seedDatabase(db, { embeddings: false });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM funds`).get() as { n: number };
    expect(n.n).toBe(3);
  });
});
