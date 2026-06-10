/**
 * Seed the Forge ontology with the fictional Vulcan Industrial Partners
 * corpus. Wipes all rows, inserts seed/ content, verifies that every
 * obligation's source_clause appears verbatim in its source document, and
 * computes embeddings when Ollama is reachable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getDb } from '../db/db.js';
import { embedAll } from '../search/embeddings.js';

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seed');

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, name), 'utf-8')) as T;
}

interface SeedFund {
  id: string;
  name: string;
  numeral: number;
  target_size_usd: number;
  strategy: string;
  status: string;
  vintage: number;
}

interface SeedInvestor {
  id: string;
  name: string;
  type: string;
  jurisdiction: string;
  commitments: Record<string, number>;
}

interface SeedProvision {
  id: string;
  topic: string;
  heading: string;
  text: string;
}

interface SeedDocument {
  id: string;
  fund_id: string | null;
  type: string;
  status: string;
  title: string;
  investor_id?: string;
  agreed_terms?: string[];
  provisions: SeedProvision[];
}

interface SeedComment {
  id: string;
  fund_id: string;
  investor_id: string;
  provision_topic: string;
  text: string;
}

interface SeedObligation {
  id: string;
  fund_id: string;
  investor_id?: string;
  source_document_id: string;
  source_provision_id?: string;
  type: string;
  summary: string;
  geography?: string;
  deadline?: string;
  notice_days?: number;
  source_clause: string;
}

function composeContent(title: string, provisions: SeedProvision[]): string {
  const parts = [title, ''];
  for (const p of provisions) {
    parts.push(p.heading, '', p.text, '');
  }
  return parts.join('\n');
}

export interface SeedSummary {
  funds: number;
  investors: number;
  documents: number;
  provisions: number;
  comments: number;
  obligations: number;
  unverifiedObligations: string[];
  embeddings: number;
}

export async function seedDatabase(db: Database.Database, opts: { embeddings?: boolean } = {}): Promise<SeedSummary> {
  const wipe = db.transaction(() => {
    for (const table of [
      'embeddings',
      'ai_calls',
      'obligations',
      'side_letters',
      'comments',
      'provisions',
      'documents',
      'commitments',
      'investors',
      'funds',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  wipe();

  const funds = readJson<SeedFund[]>('funds.json');
  const investors = readJson<SeedInvestor[]>('investors.json');
  const modelProvisions = readJson<SeedProvision[]>('model-provisions.json');
  const documents = readJson<SeedDocument[]>('documents.json');
  const comments = readJson<SeedComment[]>('comments.json');
  const obligations = readJson<SeedObligation[]>('obligations.json');
  const termSheet = fs.readFileSync(path.join(SEED_DIR, 'term-sheet.md'), 'utf-8');

  const insertFund = db.prepare(
    `INSERT INTO funds (id, name, numeral, target_size_usd, strategy, status, vintage) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertInvestor = db.prepare(`INSERT INTO investors (id, name, type, jurisdiction) VALUES (?, ?, ?, ?)`);
  const insertCommitment = db.prepare(`INSERT INTO commitments (fund_id, investor_id, amount_usd) VALUES (?, ?, ?)`);
  const insertDocument = db.prepare(
    `INSERT INTO documents (id, fund_id, type, status, investor_id, title, content) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertProvision = db.prepare(
    `INSERT INTO provisions (id, document_id, topic, heading, text, position) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSideLetter = db.prepare(
    `INSERT INTO side_letters (id, fund_id, investor_id, document_id, agreed_terms_json) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertComment = db.prepare(
    `INSERT INTO comments (id, fund_id, investor_id, provision_topic, text, status) VALUES (?, ?, ?, ?, ?, 'open')`,
  );
  const insertObligation = db.prepare(
    `INSERT INTO obligations (id, fund_id, investor_id, source_document_id, source_provision_id, type, summary, geography, deadline, notice_days, source_clause, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const docContents = new Map<string, string>();
  const unverified: string[] = [];

  const insertAll = db.transaction(() => {
    for (const f of funds) {
      insertFund.run(f.id, f.name, f.numeral, f.target_size_usd, f.strategy, f.status, f.vintage);
    }
    for (const inv of investors) {
      insertInvestor.run(inv.id, inv.name, inv.type, inv.jurisdiction);
      for (const [fundId, amount] of Object.entries(inv.commitments)) {
        insertCommitment.run(fundId, inv.id, amount);
      }
    }

    // Model document library
    const modelDocId = 'doc-model-lpa';
    insertDocument.run(
      modelDocId,
      null,
      'model_doc',
      'model',
      null,
      'Vulcan Form of Limited Partnership Agreement (Model Document Library)',
      composeContent('Vulcan Form LPA — Model Provisions', modelProvisions),
    );
    modelProvisions.forEach((p, i) => insertProvision.run(p.id, modelDocId, p.topic, p.heading, p.text, i + 1));

    // Fund III term sheet
    insertDocument.run('doc-f3-termsheet', 'fund-3', 'term_sheet', 'draft', null, 'Vulcan Industrial Partners III — Summary of Principal Terms', termSheet);

    // LPAs, side letters, Fund III draft
    for (const doc of documents) {
      const content = composeContent(doc.title, doc.provisions);
      docContents.set(doc.id, content);
      insertDocument.run(doc.id, doc.fund_id, doc.type, doc.status, doc.investor_id ?? null, doc.title, content);
      doc.provisions.forEach((p, i) => insertProvision.run(p.id, doc.id, p.topic, p.heading, p.text, i + 1));
      if (doc.type === 'side_letter' && doc.investor_id && doc.fund_id) {
        insertSideLetter.run(`sl-${doc.id}`, doc.fund_id, doc.investor_id, doc.id, JSON.stringify(doc.agreed_terms ?? []));
      }
    }

    for (const c of comments) {
      insertComment.run(c.id, c.fund_id, c.investor_id, c.provision_topic, c.text);
    }

    for (const o of obligations) {
      const content = docContents.get(o.source_document_id) ?? '';
      const verified = content.includes(o.source_clause) ? 1 : 0;
      if (!verified) unverified.push(o.id);
      insertObligation.run(
        o.id,
        o.fund_id,
        o.investor_id ?? null,
        o.source_document_id,
        o.source_provision_id ?? null,
        o.type,
        o.summary,
        o.geography ?? null,
        o.deadline ?? null,
        o.notice_days ?? null,
        o.source_clause,
        verified,
      );
    }
  });
  insertAll();

  // Embeddings (skipped gracefully when Ollama is down)
  let embedded = 0;
  if (opts.embeddings !== false) {
    const provisionRows = db.prepare(`SELECT id, heading, text FROM provisions`).all() as Array<{
      id: string;
      heading: string;
      text: string;
    }>;
    const obligationRows = db.prepare(`SELECT id, summary, source_clause FROM obligations`).all() as Array<{
      id: string;
      summary: string;
      source_clause: string;
    }>;
    const commentRows = db.prepare(`SELECT id, text FROM comments`).all() as Array<{ id: string; text: string }>;
    embedded = await embedAll(db, [
      ...provisionRows.map((p) => ({ ownerType: 'provision' as const, ownerId: p.id, text: `${p.heading}\n${p.text}` })),
      ...obligationRows.map((o) => ({ ownerType: 'obligation' as const, ownerId: o.id, text: `${o.summary}\n${o.source_clause}` })),
      ...commentRows.map((c) => ({ ownerType: 'comment' as const, ownerId: c.id, text: c.text })),
    ]);
  }

  return {
    funds: funds.length,
    investors: investors.length,
    documents: documents.length + 2,
    provisions: (db.prepare(`SELECT COUNT(*) AS n FROM provisions`).get() as { n: number }).n,
    comments: comments.length,
    obligations: obligations.length,
    unverifiedObligations: unverified,
    embeddings: embedded,
  };
}

// CLI entry: npm run seed
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const summary = await seedDatabase(getDb());
  console.log('Seeded Forge ontology:');
  console.log(`  funds: ${summary.funds}, investors: ${summary.investors}, documents: ${summary.documents}`);
  console.log(`  provisions: ${summary.provisions}, comments: ${summary.comments}, obligations: ${summary.obligations}`);
  console.log(`  embeddings stored: ${summary.embeddings}${summary.embeddings === 0 ? ' (Ollama unreachable — keyword search only)' : ''}`);
  if (summary.unverifiedObligations.length > 0) {
    console.warn(`  ⚠ unverified obligation citations: ${summary.unverifiedObligations.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('  ✓ all obligation source clauses verified verbatim against source documents');
  }
}
