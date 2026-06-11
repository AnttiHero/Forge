/**
 * Regression tests for the confirmed quality-sweep findings: citation
 * fallback laundering, BM25 rank inversion, MFN parsing gaps, and the
 * gateway's scoped-masking blind spots.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, setDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { quoteAppearsIn } from './citations.js';
import { promotePrecedent, searchPrecedents } from './precedent.js';
import { parseWindowDays, assembleCompendiumData } from './mfn.js';
import { sanitizeOutbound, resetGateway } from '../ai/gateway.js';
import { resetHealthCache } from '../ai/ollama.js';

const MAPPINGS = [
  { placeholder: '[INVESTOR_1]', original: 'Norrland Pension AB', type: 'investor' as const },
  { placeholder: '[INVESTOR_2]', original: 'Equatorial Development Finance Corporation', type: 'investor' as const },
];

describe('citation fallback keeps slot identity (sweep #8)', () => {
  const source =
    'Norrland Pension AB shall notify Equatorial Development Finance Corporation within thirty days of any excused investment decision.';

  it('an invented placeholder wildcards ONLY its own slot', () => {
    // right party + invented slot for the other entity → verifies
    expect(quoteAppearsIn(source, '[INVESTOR_1] shall notify [INVESTOR_9] within thirty days', MAPPINGS)).toBe(true);
  });

  it('a wrong-party quote cannot launder itself through an invented slot', () => {
    // EDFC swapped into Norrland's slot, invented slot elsewhere — under the
    // old all-generic fallback this verified; it must not
    expect(quoteAppearsIn(source, '[INVESTOR_2] shall notify [INVESTOR_9] within thirty days', MAPPINGS)).toBe(false);
  });
});

describe('BM25 rank normalization (sweep #1)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bm25-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    setDb(db);
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ollama down')));
  });

  afterEach(() => {
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('the strongest keyword match ranks first, not last', async () => {
    await promotePrecedent(db, {
      kind: 'resolution',
      topic: 'co_invest',
      title: 'co-investment allocation policy',
      text: 'Co-investment allocation follows commitment size. Co-investment allocation decisions rest with the General Partner. Allocation of co-investment opportunities is final.',
      sourceType: 'comment',
      sourceId: 'sweep-strong',
      fundId: 'fund-2',
      weight: 1.0,
    });
    await promotePrecedent(db, {
      kind: 'resolution',
      topic: 'co_invest',
      title: 'transfer consent mechanics',
      text: 'Transfers require General Partner consent and notice periods apply to each transferring partner with customary exceptions for affiliates; allocation and co-investment are mentioned once in passing here.',
      sourceType: 'comment',
      sourceId: 'sweep-weak',
      fundId: 'fund-2',
      weight: 1.0,
    });
    const hits = await searchPrecedents(db, { query: 'co-investment allocation', topic: 'co_invest', topK: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0].title).toBe('co-investment allocation policy');
    expect(hits[0].relevance).toBeGreaterThan(hits[1].relevance);
  });
});

describe('MFN parsing gaps (sweep #4, #5)', () => {
  it('parses qualified day counts', () => {
    expect(parseWindowDays('within fifteen (15) Business Days of receipt')).toBe(15);
    expect(parseWindowDays('within 10 business days of delivery')).toBe(10);
    expect(parseWindowDays('within thirty calendar days')).toBe(30);
    expect(parseWindowDays('within thirty (30) days of receipt of the compendium')).toBe(30);
  });

  describe('unparseable monetary threshold', () => {
    let dir: string;
    let db: Database.Database;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mfnthr-'));
      db = openDb(path.join(dir, 'test.db'));
      await seedDatabase(db, { embeddings: false });
    });

    afterEach(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('declares electors unknown instead of "everyone"', () => {
      // a monetary test the parser cannot read — no "$", spelled-out amount
      db.prepare(`UPDATE obligations SET source_clause = ? WHERE id = 'obl-10'`).run(
        'Each Limited Partner whose Commitment equals or exceeds seventy-five million dollars may elect the benefit of any side letter provision within thirty (30) days.',
      );
      const data = assembleCompendiumData(db, 'fund-2');
      expect(data.basis?.thresholdUsd).toBeNull();
      expect(data.thresholdUnparsed).toBe(true);
      expect(data.electors).toEqual([]);
    });

    it('keeps normal behavior when the clause genuinely has no monetary test', () => {
      db.prepare(`UPDATE obligations SET source_clause = ? WHERE id = 'obl-10'`).run(
        'Each Limited Partner may elect the benefit of any side letter provision within thirty (30) days.',
      );
      const data = assembleCompendiumData(db, 'fund-2');
      expect(data.thresholdUnparsed).toBe(false);
      expect(data.electors.length).toBeGreaterThan(0); // threshold 0 → all committed LPs
    });
  });
});

describe('gateway scoped-masking blind spots (sweep #7, #11)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gwscope-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    setDb(db);
    resetGateway();
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ollama down'))); // regex-only — the worst case
  });

  afterEach(() => {
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('protectNames masks an LP the scoped ontology query cannot see', async () => {
    const { sanitized } = await sanitizeOutbound(
      'Counsel to Zephyrhaven Capital Trust writes: Zephyrhaven requires a fee step-down.',
      undefined,
      'fund-2',
      ['Zephyrhaven Capital Trust'],
    );
    expect(sanitized).not.toContain('Zephyrhaven');
  });

  it('scoped terms include investors linked by documents, not just commitments', async () => {
    db.prepare(`INSERT INTO investors (id, name, type, jurisdiction) VALUES ('inv-sweep', 'Zephyrhaven Capital Trust', 'other', '')`).run();
    db.prepare(
      `INSERT INTO documents (id, fund_id, type, status, investor_id, title, content) VALUES ('doc-sweep', 'fund-2', 'side_letter', 'closed', 'inv-sweep', 'SL', 'x')`,
    ).run();
    const { sanitized } = await sanitizeOutbound('Zephyrhaven Capital Trust gets quarterly reports.', undefined, 'fund-2');
    expect(sanitized).not.toContain('Zephyrhaven');
  });
});
