/**
 * Deadlines — obligations that act.
 *
 * Turns the obligations register from "answers questions" into "prevents
 * breaches": computes actual due dates for recurring duties (anchored to
 * fiscal periods, with business-day math where the clause says Business
 * Days), plans event-triggered duties around a real date ("we're closing
 * July 15 — notice to Norrland is due June 24"), drafts the reminder
 * email with verified citations, and exports everything as an iCalendar.
 *
 * All date math is deterministic and local — no model call, instantly
 * explainable. Only the email drafting touches the frontier, through the
 * same gateway as everything else.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getDb } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';

// ── Date helpers (UTC, ISO date strings) ─────────────────────────────────

function fromISO(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = fromISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/** Add (or with negative n, subtract) business days — weekends skipped.
 *  Public holidays are not modeled; flagged as an approximation in the UI. */
export function addBusinessDays(iso: string, n: number): string {
  const d = fromISO(iso);
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return toISODate(d);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((fromISO(toIso).getTime() - fromISO(fromIso).getTime()) / 86_400_000);
}

function quarterEndsBetween(fromIso: string, toIso: string): Array<{ iso: string; quarter: number; year: number }> {
  const out: Array<{ iso: string; quarter: number; year: number }> = [];
  const startYear = fromISO(fromIso).getUTCFullYear();
  const endYear = fromISO(toIso).getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) {
    const ends: Array<[number, string]> = [
      [1, `${y}-03-31`],
      [2, `${y}-06-30`],
      [3, `${y}-09-30`],
      [4, `${y}-12-31`],
    ];
    for (const [q, iso] of ends) {
      if (iso >= fromIso && iso <= toIso) out.push({ iso, quarter: q, year: y });
    }
  }
  return out;
}

// ── Cadence classification (deterministic, from the clause itself) ───────

export type Cadence = 'quarterly' | 'annual' | 'event_before' | 'event_after' | 'unscheduled';

const WITHIN_DAYS = /(within|no later than|no fewer than)\s+[\w() \-]{0,30}\b(business\s+)?days\b/i;
const PERIOD_ANCHOR = /after the end of each/i;

/** A clause can carry several cadences at once — EDFC's impact report is due
 *  "45 days after the closing ... and annually thereafter". */
export function classifyCadences(text: string): Set<Cadence> {
  const t = text.toLowerCase();
  const out = new Set<Cadence>();
  if (/quarter/.test(t)) out.add('quarterly');
  if (/annual|each fiscal year|year-end/.test(t)) out.add('annual');
  if (/prior to|before the closing|in advance of|advance (written )?notice/.test(t)) out.add('event_before');
  if (WITHIN_DAYS.test(t) && !PERIOD_ANCHOR.test(t) && !out.has('event_before')) out.add('event_after');
  if (out.size === 0) out.add('unscheduled');
  return out;
}

/** Primary cadence for display. */
export function classifyCadence(text: string): Cadence {
  const set = classifyCadences(text);
  for (const c of ['quarterly', 'annual', 'event_before', 'event_after'] as const) {
    if (set.has(c)) return c;
  }
  return 'unscheduled';
}

function usesBusinessDays(text: string): boolean {
  return /business days/i.test(text);
}

// ── Upcoming recurring deadlines ─────────────────────────────────────────

interface ObligationRow {
  id: string;
  fund_id: string;
  type: string;
  summary: string;
  geography: string | null;
  notice_days: number | null;
  source_clause: string;
  verified: number;
  fund_name: string;
  investor_name: string | null;
}

export interface Deadline {
  obligationId: string;
  fundId: string;
  fundName: string;
  investorName: string | null;
  type: string;
  summary: string;
  sourceClause: string;
  verified: boolean;
  cadence: Cadence;
  periodLabel: string;
  dueDate: string;
  daysUntil: number;
  overdue: boolean;
  businessDays: boolean;
}

export interface EventDuty {
  obligationId: string;
  fundId: string;
  fundName: string;
  investorName: string | null;
  type: string;
  summary: string;
  sourceClause: string;
  verified: boolean;
  cadence: 'event_before' | 'event_after';
  leadDays: number;
  businessDays: boolean;
  geography: string | null;
}

function loadObligations(db: Database.Database, fundId?: string): ObligationRow[] {
  const where = fundId ? 'WHERE o.fund_id = ?' : '';
  const params = fundId ? [fundId] : [];
  return db
    .prepare(
      `SELECT o.id, o.fund_id, o.type, o.summary, o.geography, o.notice_days, o.source_clause, o.verified,
              f.name AS fund_name, i.name AS investor_name
       FROM obligations o
       JOIN funds f ON f.id = o.fund_id
       LEFT JOIN investors i ON i.id = o.investor_id
       ${where}`,
    )
    .all(...params) as ObligationRow[];
}

/**
 * Compute concrete due dates for recurring obligations within the horizon,
 * assuming a calendar fiscal year. Slightly-overdue items (≤30 days) are
 * kept and flagged so a missed deadline is loud, not silent.
 */
export function computeUpcomingDeadlines(
  db: Database.Database,
  opts: { fundId?: string; withinDays?: number; today?: string } = {},
): { deadlines: Deadline[]; eventDuties: EventDuty[] } {
  const today = opts.today ?? toISODate(new Date());
  const horizon = addDays(today, opts.withinDays ?? 180);
  const windowStart = addDays(today, -30);

  const deadlines: Deadline[] = [];
  const eventDuties: EventDuty[] = [];

  for (const o of loadObligations(db, opts.fundId)) {
    if (o.notice_days === null) continue;
    const clauseText = `${o.summary} ${o.source_clause}`;
    const cadences = classifyCadences(clauseText);
    const cadence = classifyCadence(clauseText);
    const bd = usesBusinessDays(o.source_clause);
    const due = (anchor: string): string => (bd ? addBusinessDays(anchor, o.notice_days!) : addDays(anchor, o.notice_days!));

    const push = (anchorIso: string, periodLabel: string): void => {
      const dueDate = due(anchorIso);
      if (dueDate < windowStart || dueDate > horizon) return;
      deadlines.push({
        obligationId: o.id,
        fundId: o.fund_id,
        fundName: o.fund_name,
        investorName: o.investor_name,
        type: o.type,
        summary: o.summary,
        sourceClause: o.source_clause,
        verified: o.verified === 1,
        cadence,
        periodLabel,
        dueDate,
        daysUntil: daysBetween(today, dueDate),
        overdue: dueDate < today,
        businessDays: bd,
      });
    };

    if (cadences.has('quarterly')) {
      // some clauses cover only the first three fiscal quarters
      const firstThreeOnly = /first three fiscal quarters/i.test(o.source_clause);
      for (const q of quarterEndsBetween(addDays(windowStart, -120), horizon)) {
        if (firstThreeOnly && q.quarter === 4) continue;
        push(q.iso, `Q${q.quarter} ${q.year}`);
      }
    } else if (cadences.has('annual')) {
      const startYear = fromISO(windowStart).getUTCFullYear() - 1;
      const endYear = fromISO(horizon).getUTCFullYear();
      for (let y = startYear; y <= endYear; y++) {
        push(`${y}-12-31`, `FY ${y}`);
      }
    }
    // a clause can be recurring AND event-triggered (e.g. "45 days after the
    // closing ... and annually thereafter") — both schedules are real duties
    const eventCadence = cadences.has('event_before') ? 'event_before' : cadences.has('event_after') ? 'event_after' : null;
    if (eventCadence) {
      eventDuties.push({
        obligationId: o.id,
        fundId: o.fund_id,
        fundName: o.fund_name,
        investorName: o.investor_name,
        type: o.type,
        summary: o.summary,
        sourceClause: o.source_clause,
        verified: o.verified === 1,
        cadence: eventCadence,
        leadDays: o.notice_days,
        businessDays: bd,
        geography: o.geography,
      });
    }
  }

  deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { deadlines, eventDuties };
}

// ── Event planner — "we're closing on July 15, what's due when?" ─────────

export interface PlannedDuty extends EventDuty {
  actionDate: string;
  direction: 'before' | 'after';
  daysUntil: number;
  overdue: boolean;
  matchedBy: 'search' | 'geography';
}

export async function planEvent(
  db: Database.Database,
  opts: { eventDescription: string; eventDate: string; fundId?: string; today?: string },
): Promise<{ duties: PlannedDuty[] }> {
  const today = opts.today ?? toISODate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.eventDate)) throw new Error('eventDate must be YYYY-MM-DD');

  const { eventDuties } = computeUpcomingDeadlines(db, { fundId: opts.fundId, today });

  // relevance: local hybrid search over the register ∪ geography keyword match
  const hits = await hybridSearch(db, {
    query: opts.eventDescription,
    table: 'obligations',
    fundId: opts.fundId,
    topK: 12,
  });
  const hitIds = new Set(hits.map((h) => h.id));
  const desc = opts.eventDescription.toLowerCase();

  const duties: PlannedDuty[] = [];
  for (const d of eventDuties) {
    const geoMatch = d.geography !== null && desc.includes(d.geography.toLowerCase());
    const searchMatch = hitIds.has(d.obligationId);
    if (!geoMatch && !searchMatch) continue;
    const direction = d.cadence === 'event_before' ? 'before' : 'after';
    const actionDate =
      direction === 'before'
        ? d.businessDays
          ? addBusinessDays(opts.eventDate, -d.leadDays)
          : addDays(opts.eventDate, -d.leadDays)
        : d.businessDays
          ? addBusinessDays(opts.eventDate, d.leadDays)
          : addDays(opts.eventDate, d.leadDays);
    duties.push({
      ...d,
      actionDate,
      direction,
      daysUntil: daysBetween(today, actionDate),
      overdue: actionDate < today,
      matchedBy: geoMatch ? 'geography' : 'search',
    });
  }

  duties.sort((a, b) => a.actionDate.localeCompare(b.actionDate));
  return { duties };
}

// ── Reminder email (the one frontier call here) ──────────────────────────

const emailSchema = z.object({
  subject: z.string().describe('Email subject line, starts with the due date'),
  body: z
    .string()
    .describe('Plain-text email body: what is due, when, to whom it is owed, the exact clause quoted, and the next action'),
  citations: z.array(citationSchema),
});

export interface ReminderEmail extends z.infer<typeof emailSchema> {
  obligationId: string;
  citationsVerified: { total: number; verified: number };
}

export async function draftReminderEmail(
  obligationId: string,
  opts: { dueDate?: string; periodLabel?: string; eventDescription?: string } = {},
): Promise<ReminderEmail> {
  const db = getDb();
  const o = db
    .prepare(
      `SELECT o.*, f.name AS fund_name, i.name AS investor_name
       FROM obligations o JOIN funds f ON f.id = o.fund_id LEFT JOIN investors i ON i.id = o.investor_id
       WHERE o.id = ?`,
    )
    .get(obligationId) as
    | (ObligationRow & { deadline: string | null })
    | undefined;
  if (!o) throw new Error(`Unknown obligation: ${obligationId}`);

  const result = await callStructured({
    stage: 'deadlines.email',
    scopeFundId: o.fund_id,
    system: `You draft internal compliance reminder emails for a fund manager's legal team. Tone: brief, factual, zero fluff. Structure: what is due and when, who it is owed to, the exact clause (quoted verbatim in a quote block), and the single next action with an owner placeholder like [OWNER]. The citation quote must be copied verbatim from the obligation record provided.`,
    user: `OBLIGATION RECORD [sourceType: obligation, sourceId: ${o.id}]:
fund: ${o.fund_name}
owed to: ${o.investor_name ?? 'all Limited Partners'}
type: ${o.type}
summary: ${o.summary}
source clause: "${o.source_clause}"
${opts.dueDate ? `DUE DATE: ${opts.dueDate}${opts.periodLabel ? ` (${opts.periodLabel})` : ''}` : ''}
${opts.eventDescription ? `TRIGGERING EVENT: ${opts.eventDescription}` : ''}

Draft the reminder email.`,
    schema: emailSchema,
    maxTokens: 3_000,
    effort: 'medium',
  });

  return { ...result.data, obligationId, citationsVerified: result.citations };
}

// ── iCalendar export ─────────────────────────────────────────────────────

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function deadlinesToICS(deadlines: Deadline[], calendarName = 'Forge Obligations'): string {
  const stamp = `${toISODate(new Date()).replace(/-/g, '')}T000000Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Forge//Obligations//EN',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];
  for (const d of deadlines) {
    const date = d.dueDate.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${d.obligationId}-${d.dueDate}@forge.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${icsEscape(`${d.fundName.replace(/, L\.P\.$/, '')} — ${d.summary}`)}`,
      `DESCRIPTION:${icsEscape(
        `${d.periodLabel} · owed to ${d.investorName ?? 'all LPs'} · ${d.type}\nSource (${d.obligationId}): "${d.sourceClause}"`,
      )}`,
      'BEGIN:VALARM',
      'TRIGGER:-P7D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(d.summary)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
