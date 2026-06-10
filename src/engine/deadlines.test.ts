import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { resetHealthCache } from '../ai/ollama.js';
import {
  addBusinessDays,
  addDays,
  classifyCadence,
  computeUpcomingDeadlines,
  deadlinesToICS,
  planEvent,
} from './deadlines.js';

describe('date math', () => {
  it('adds calendar days across month ends', () => {
    expect(addDays('2026-06-30', 45)).toBe('2026-08-14');
    expect(addDays('2026-12-31', 90)).toBe('2027-03-31');
  });

  it('subtracts business days across weekends', () => {
    // 2026-07-15 is a Wednesday; 15 business days back lands on 2026-06-24
    expect(addBusinessDays('2026-07-15', -15)).toBe('2026-06-24');
    // forward across a weekend: Fri + 1 BD = Mon
    expect(addBusinessDays('2026-06-12', 1)).toBe('2026-06-15');
  });
});

describe('cadence classification', () => {
  it('classifies from real seed clauses', () => {
    expect(classifyCadence('unaudited quarterly reports within forty-five (45) days after the end of each of the first three fiscal quarters')).toBe('quarterly');
    expect(classifyCadence('an annual environmental, social and governance report within one hundred twenty (120) days after the end of each fiscal year')).toBe('annual');
    expect(classifyCadence('written notice no fewer than fifteen (15) Business Days prior to the closing of such investment')).toBe('event_before');
    expect(classifyCadence('notify the Limited Partners within ten (10) Business Days')).toBe('event_after');
  });
});

describe('deadline engine on the seeded register', () => {
  let dir: string;
  let db: Database.Database;
  const TODAY = '2026-06-10';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deadlines-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ollama down')));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('computes recurring due dates with period labels', () => {
    const { deadlines } = computeUpcomingDeadlines(db, { today: TODAY, withinDays: 120 });
    // obl-11: Fund II quarterly reports within 45 days → Q2 2026 due Aug 14
    const q2 = deadlines.find((d) => d.obligationId === 'obl-11' && d.periodLabel === 'Q2 2026');
    expect(q2?.dueDate).toBe('2026-08-14');
    expect(q2?.overdue).toBe(false);
    // obl-19: Hokuriku quarterly currency statement within 30 days → Q2 due Jul 30
    const hoku = deadlines.find((d) => d.obligationId === 'obl-19' && d.periodLabel === 'Q2 2026');
    expect(hoku?.dueDate).toBe('2026-07-30');
    // sorted ascending
    const dates = deadlines.map((d) => d.dueDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('skips Q4 for first-three-quarters clauses and includes annual FY duties', () => {
    const { deadlines } = computeUpcomingDeadlines(db, { today: TODAY, withinDays: 365 });
    const obl11 = deadlines.filter((d) => d.obligationId === 'obl-11');
    expect(obl11.some((d) => d.periodLabel.startsWith('Q4'))).toBe(false);
    // obl-03: Norrland ESG report 120 days after FY2026 end → 2027-04-30
    const esg = deadlines.find((d) => d.obligationId === 'obl-03' && d.periodLabel === 'FY 2026');
    expect(esg?.dueDate).toBe('2027-04-30');
  });

  it('plans an event: Norrland notice due 15 business days before closing', async () => {
    const { duties } = await planEvent(db, {
      eventDescription: 'Closing a new investment in sub-Saharan Africa',
      eventDate: '2026-07-15',
      today: TODAY,
    });
    const norrland = duties.find((d) => d.obligationId === 'obl-02');
    expect(norrland).toBeDefined();
    expect(norrland?.direction).toBe('before');
    expect(norrland?.actionDate).toBe('2026-06-24');
    // EDFC impact report 45 days AFTER closing
    const edfc = duties.find((d) => d.obligationId === 'obl-04');
    expect(edfc?.direction).toBe('after');
    expect(edfc?.actionDate).toBe('2026-08-29');
  });

  it('exports valid ICS with one VEVENT per deadline', () => {
    const { deadlines } = computeUpcomingDeadlines(db, { today: TODAY, withinDays: 90 });
    const ics = deadlinesToICS(deadlines.slice(0, 3));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('DTSTART;VALUE=DATE:');
    expect(ics).toContain('END:VCALENDAR');
  });
});
