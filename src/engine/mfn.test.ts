import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { assembleCompendiumData, findMfnBasis, parseThresholdUsd, parseWindowDays } from './mfn.js';

describe('MFN clause parsing', () => {
  it('parses dollar thresholds', () => {
    expect(parseThresholdUsd('Commitment equals or exceeds $75,000,000')).toBe(75_000_000);
    expect(parseThresholdUsd('at least $50 million')).toBe(50_000_000);
    expect(parseThresholdUsd('no monetary test')).toBeNull();
  });

  it('parses election windows', () => {
    expect(parseWindowDays('within thirty (30) days of receipt of the compendium')).toBe(30);
    expect(parseWindowDays('within 45 days of delivery')).toBe(45);
    expect(parseWindowDays('within sixty days')).toBe(60);
    expect(parseWindowDays('promptly')).toBeNull();
  });
});

describe('compendium assembly on the seeded register', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mfn-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the fund-wide MFN basis with threshold and window', () => {
    const basis = findMfnBasis(db, 'fund-2');
    expect(basis?.sourceId).toBe('obl-10');
    expect(basis?.thresholdUsd).toBe(75_000_000);
    expect(basis?.windowDays).toBe(30);
  });

  it('collects every Fund II side-letter provision with its grantee', () => {
    const data = assembleCompendiumData(db, 'fund-2');
    expect(data.provisions).toHaveLength(6); // Norrland 3 + EDFC 3
    const grantees = new Set(data.provisions.map((p) => p.granteeName));
    expect(grantees).toEqual(new Set(['Norrland Pension AB', 'Equatorial Development Finance Corporation']));
  });

  it('filters electors by the parsed threshold', () => {
    const data = assembleCompendiumData(db, 'fund-2');
    // Fund II commitments ≥ $75M: Khalij 200, Keystone 175, Ontario 120, Norrland 90, Hokuriku 85, EDFC 75
    expect(data.electors.map((e) => e.name)).toEqual([
      'Khalij Investment Authority',
      "Keystone State Teachers' Retirement System",
      'Ontario Metalworkers Pension Plan',
      'Norrland Pension AB',
      'Hokuriku Mutual Life Insurance Company',
      'Equatorial Development Finance Corporation',
    ]);
    expect(data.electors.every((e) => e.commitmentUsd >= 75_000_000)).toBe(true);
  });
});
