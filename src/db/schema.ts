/**
 * Forge ontology — the connective tissue across the fundraising life cycle.
 *
 * funds → investors (via commitments) → documents → provisions →
 * comments / side_letters → obligations. Every AI call is audited in
 * ai_calls (the "what left your machine" record). Embeddings live beside
 * the rows they index.
 */

import type Database from 'better-sqlite3';

const TABLES = `
CREATE TABLE IF NOT EXISTS funds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  numeral INTEGER NOT NULL,
  target_size_usd INTEGER NOT NULL,
  strategy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('forming', 'closed')),
  vintage INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS investors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pension', 'swf', 'endowment', 'insurer', 'fund_of_funds', 'family_office', 'dfi')),
  jurisdiction TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS commitments (
  fund_id TEXT NOT NULL REFERENCES funds(id),
  investor_id TEXT NOT NULL REFERENCES investors(id),
  amount_usd INTEGER NOT NULL,
  PRIMARY KEY (fund_id, investor_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  fund_id TEXT REFERENCES funds(id),
  type TEXT NOT NULL CHECK (type IN ('lpa', 'side_letter', 'term_sheet', 'model_doc')),
  status TEXT NOT NULL CHECK (status IN ('model', 'draft', 'closed')),
  investor_id TEXT REFERENCES investors(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  topic TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  investor_id TEXT NOT NULL REFERENCES investors(id),
  provision_topic TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suggested', 'resolved')),
  suggested_resolution TEXT,
  suggestion_citations_json TEXT,
  resolution_text TEXT,
  resolved_by TEXT CHECK (resolved_by IN ('lawyer_accepted', 'lawyer_edited')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS side_letters (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  investor_id TEXT NOT NULL REFERENCES investors(id),
  document_id TEXT REFERENCES documents(id),
  agreed_terms_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  investor_id TEXT REFERENCES investors(id),
  source_document_id TEXT NOT NULL REFERENCES documents(id),
  source_provision_id TEXT REFERENCES provisions(id),
  type TEXT NOT NULL CHECK (type IN ('notice', 'consent', 'reporting', 'excuse', 'transfer_restriction', 'mfn', 'investment_restriction')),
  summary TEXT NOT NULL,
  geography TEXT,
  deadline TEXT,
  notice_days INTEGER,
  source_clause TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  sanitized_prompt TEXT NOT NULL,
  entity_stats_json TEXT NOT NULL DEFAULT '{}',
  ner_used INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS embeddings (
  owner_type TEXT NOT NULL CHECK (owner_type IN ('provision', 'comment', 'obligation', 'side_letter')),
  owner_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_provisions_document ON provisions(document_id);
CREATE INDEX IF NOT EXISTS idx_provisions_topic ON provisions(topic);
CREATE INDEX IF NOT EXISTS idx_obligations_fund ON obligations(fund_id);
CREATE INDEX IF NOT EXISTS idx_comments_fund ON comments(fund_id);
CREATE INDEX IF NOT EXISTS idx_documents_fund ON documents(fund_id);
`;

// FTS5 virtual tables must be created with separate exec calls; CREATE VIRTUAL
// TABLE has no IF NOT EXISTS-safe trigger story across versions, so swallow
// only "already exists" errors.
const FTS_STATEMENTS = [
  `CREATE VIRTUAL TABLE provisions_fts USING fts5(heading, text, content='provisions', content_rowid='rowid')`,
  `CREATE TRIGGER provisions_ai AFTER INSERT ON provisions BEGIN
     INSERT INTO provisions_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text);
   END`,
  `CREATE TRIGGER provisions_ad AFTER DELETE ON provisions BEGIN
     INSERT INTO provisions_fts(provisions_fts, rowid, heading, text) VALUES ('delete', old.rowid, old.heading, old.text);
   END`,
  `CREATE TRIGGER provisions_au AFTER UPDATE ON provisions BEGIN
     INSERT INTO provisions_fts(provisions_fts, rowid, heading, text) VALUES ('delete', old.rowid, old.heading, old.text);
     INSERT INTO provisions_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text);
   END`,
  `CREATE VIRTUAL TABLE obligations_fts USING fts5(summary, source_clause, content='obligations', content_rowid='rowid')`,
  `CREATE TRIGGER obligations_ai AFTER INSERT ON obligations BEGIN
     INSERT INTO obligations_fts(rowid, summary, source_clause) VALUES (new.rowid, new.summary, new.source_clause);
   END`,
  `CREATE TRIGGER obligations_ad AFTER DELETE ON obligations BEGIN
     INSERT INTO obligations_fts(obligations_fts, rowid, summary, source_clause) VALUES ('delete', old.rowid, old.summary, old.source_clause);
   END`,
  `CREATE TRIGGER obligations_au AFTER UPDATE ON obligations BEGIN
     INSERT INTO obligations_fts(obligations_fts, rowid, summary, source_clause) VALUES ('delete', old.rowid, old.summary, old.source_clause);
     INSERT INTO obligations_fts(rowid, summary, source_clause) VALUES (new.rowid, new.summary, new.source_clause);
   END`,
];

export function initSchema(db: Database.Database): void {
  db.exec(TABLES);
  for (const stmt of FTS_STATEMENTS) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) throw err;
    }
  }
}
