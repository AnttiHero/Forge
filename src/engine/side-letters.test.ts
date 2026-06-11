import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { executeSideLetter } from './side-letters.js';
import { matchInvestorName } from './obligations.js';
import { resolveOrCreateInvestor, ingestDocument } from './intake.js';
import { assembleCompendiumData } from './mfn.js';

describe('matchInvestorName', () => {
  const known = [
    { id: 'a', name: 'Norrland Pension AB' },
    { id: 'b', name: 'Khalij Investment Authority' },
    { id: 'c', name: "Keystone State Teachers' Retirement System" },
  ];

  it('matches exact names case-insensitively', () => {
    expect(matchInvestorName(known, 'norrland pension ab')?.id).toBe('a');
  });

  it('matches short forms by containment', () => {
    expect(matchInvestorName(known, 'Norrland')?.id).toBe('a');
    expect(matchInvestorName(known, 'Khalij Investment')?.id).toBe('b');
  });

  it('normalizes punctuation', () => {
    expect(matchInvestorName(known, 'Keystone State Teachers Retirement System')?.id).toBe('c');
  });

  it('returns null on no match or too-short input', () => {
    expect(matchInvestorName(known, 'Acme Sovereign Wealth')).toBeNull();
    expect(matchInvestorName(known, 'AB')).toBeNull();
  });
});

describe('the closed lifecycle: execute → record → compendium', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sl-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('executeSideLetter files the document, links the investor, and writes the side_letters row', async () => {
    const result = await executeSideLetter(db, {
      fundId: 'fund-2',
      investorId: 'inv-norrland',
      draft: {
        label: 'model_language',
        clauses: [
          { term: 'Co-invest', tier: 'model_language', text: 'The Investor shall be offered co-investment opportunities pro rata to its Commitment.' },
          { term: 'Reporting', tier: 'fresh_drafting', text: 'The General Partner shall deliver quarterly unaudited reports within 60 days.' },
        ],
      },
      extract: false,
    });

    expect(result.provisionCount).toBe(2);
    expect(result.obligations).toEqual([]);

    const doc = db.prepare(`SELECT type, status, investor_id, fund_id FROM documents WHERE id = ?`).get(result.documentId) as {
      type: string;
      status: string;
      investor_id: string;
      fund_id: string;
    };
    expect(doc.type).toBe('side_letter');
    expect(doc.status).toBe('closed');
    expect(doc.investor_id).toBe('inv-norrland');
    expect(doc.fund_id).toBe('fund-2');

    const sl = db.prepare(`SELECT investor_id FROM side_letters WHERE id = ?`).get(result.sideLetterId) as { investor_id: string };
    expect(sl.investor_id).toBe('inv-norrland');

    // its clauses became house precedent
    const precedents = db.prepare(`SELECT COUNT(*) AS n FROM precedents WHERE source_type = 'provision'`).get() as { n: number };
    expect(precedents.n).toBeGreaterThanOrEqual(2);
  });

  it('an executed side letter shows up in the next MFN compendium run', async () => {
    const before = assembleCompendiumData(db, 'fund-2').provisions.length;
    await executeSideLetter(db, {
      fundId: 'fund-2',
      investorId: 'inv-khalij',
      draft: {
        label: 'adapted_precedent',
        clauses: [{ term: 'Fee discount', tier: 'adapted_precedent', text: 'The management fee applicable to the Investor shall be reduced by 25 basis points.' }],
      },
      extract: false,
    });
    const data = assembleCompendiumData(db, 'fund-2');
    expect(data.provisions.length).toBe(before + 1);
    expect(data.provisions.some((p) => p.granteeName === 'Khalij Investment Authority' && /25 basis points/.test(p.text))).toBe(true);
  });

  it('executing the same draft twice reuses the filed letter instead of duplicating (sweep #6)', async () => {
    const draft = {
      label: 'model_language',
      clauses: [{ term: 'Reporting', tier: 'model_language', text: 'Quarterly reports within sixty (60) days of quarter end.' }],
    };
    const first = await executeSideLetter(db, { fundId: 'fund-2', investorId: 'inv-norrland', draft, extract: false });
    const second = await executeSideLetter(db, { fundId: 'fund-2', investorId: 'inv-norrland', draft, extract: false });
    expect(second.documentId).toBe(first.documentId);
    expect(second.sideLetterId).toBe(first.sideLetterId);
    const docs = db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE fund_id = 'fund-2' AND investor_id = 'inv-norrland' AND type = 'side_letter'`)
      .get() as { n: number };
    // exactly one new document beyond the seeded Norrland letter
    expect(docs.n).toBe(2);
  });

  it('resolveOrCreateInvestor fuzzy-matches before creating', () => {
    const matched = resolveOrCreateInvestor(db, 'Norrland');
    expect(matched.id).toBe('inv-norrland');
    const created = resolveOrCreateInvestor(db, 'Acme Sovereign Wealth Fund');
    expect(created.id).not.toBe('inv-norrland');
    const row = db.prepare(`SELECT type FROM investors WHERE id = ?`).get(created.id) as { type: string };
    expect(row.type).toBe('other');
  });

  it('ingestDocument links an uploaded side letter to its investor and the compendium sees it', async () => {
    const text = [
      'SIDE LETTER',
      '',
      'This side letter is entered into between Vulcan Industrial Partners Fund II and Norrland Pension AB.',
      '',
      '1. Excused Investments',
      'The Investor shall be excused from participation in any Portfolio Investment in tobacco production.',
      '',
      '2. Reporting',
      'The General Partner shall provide ILPA-format quarterly reports within forty-five (45) days of quarter end.',
    ].join('\n');
    const before = assembleCompendiumData(db, 'fund-2').provisions.length;
    const result = await ingestDocument(db, {
      fundId: 'fund-2',
      buffer: Buffer.from(text, 'utf8'),
      filename: 'norrland-side-letter.txt',
      mimeType: 'text/plain',
    });
    expect(result.type).toBe('side_letter');
    expect(result.investorName).toBe('Norrland Pension AB'); // auto-detected from the opening lines
    const after = assembleCompendiumData(db, 'fund-2');
    expect(after.provisions.length).toBe(before + result.provisionCount);
  });
});
