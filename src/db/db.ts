import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { config } from '../config.js';
import { initSchema } from './schema.js';

let _db: Database.Database | null = null;

/** Open (or create) a database at the given path and initialize the schema. */
export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

/** Process-wide singleton, lazily opened at config.dbPath. */
export function getDb(): Database.Database {
  if (!_db) _db = openDb(config.dbPath);
  return _db;
}

/** Swap in an externally-created db (tests). Pass null to reset. */
export function setDb(db: Database.Database | null): void {
  if (_db && _db !== db) _db.close();
  _db = db;
}

/** Short prefixed id, e.g. "obl-3f2a9c1b". */
export function genId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}
