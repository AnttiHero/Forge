import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';

describe('schema', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-schema-'));
    db = openDb(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates all ontology tables', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const t of ['funds', 'investors', 'commitments', 'documents', 'provisions', 'comments', 'side_letters', 'obligations', 'ai_calls', 'embeddings']) {
      expect(tables).toContain(t);
    }
    expect(tables).toContain('provisions_fts');
    expect(tables).toContain('obligations_fts');
  });

  it('FTS triggers keep the index in sync', () => {
    db.prepare(`INSERT INTO funds (id, name, numeral, target_size_usd, status, vintage) VALUES ('f1', 'Fund', 1, 1, 'closed', 2018)`).run();
    db.prepare(`INSERT INTO documents (id, fund_id, type, status, title) VALUES ('d1', 'f1', 'lpa', 'closed', 'LPA')`).run();
    db.prepare(
      `INSERT INTO provisions (id, document_id, topic, heading, text, position) VALUES ('p1', 'd1', 'geographic', 'Geographic Restrictions', 'The Fund shall not invest in emerging markets.', 1)`,
    ).run();

    const hits = db.prepare(`SELECT rowid FROM provisions_fts WHERE provisions_fts MATCH 'emerging'`).all();
    expect(hits).toHaveLength(1);

    db.prepare(`UPDATE provisions SET text = 'The Fund may invest anywhere.' WHERE id = 'p1'`).run();
    expect(db.prepare(`SELECT rowid FROM provisions_fts WHERE provisions_fts MATCH 'emerging'`).all()).toHaveLength(0);
    expect(db.prepare(`SELECT rowid FROM provisions_fts WHERE provisions_fts MATCH 'anywhere'`).all()).toHaveLength(1);

    db.prepare(`DELETE FROM provisions WHERE id = 'p1'`).run();
    expect(db.prepare(`SELECT rowid FROM provisions_fts WHERE provisions_fts MATCH 'anywhere'`).all()).toHaveLength(0);
  });

  it('re-opening an existing db is idempotent', () => {
    const p = path.join(dir, 'test.db');
    db.close();
    db = openDb(p);
    db.close();
    db = openDb(p);
    expect(db.prepare('SELECT COUNT(*) AS n FROM funds').get()).toEqual({ n: 0 });
  });
});
