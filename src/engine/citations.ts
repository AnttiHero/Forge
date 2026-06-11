/**
 * Citation contract — every AI assertion must quote its source, and the
 * quote must actually appear in the cited row. Verification runs AFTER
 * de-anonymization so restored names compare against real source text.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { EntityMapping } from '../privacy/anonymize.js';

export const citationSchema = z.object({
  sourceType: z.enum(['provision', 'document', 'comment', 'side_letter', 'obligation', 'precedent']),
  sourceId: z.string(),
  quote: z.string(),
});

export type Citation = z.infer<typeof citationSchema>;

export interface VerifiedCitation extends Citation {
  verified: boolean;
}

const GENERIC_SLOT = 'xslotx'; // wildcard for a placeholder the mapping can't resolve

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Identity token for one masked entity — derived from its ORIGINAL value,
 *  so Norrland's slot can never match EDFC's, and a swapped amount or date
 *  can't verify against a different one. */
function identToken(original: string): string {
  const h = crypto.createHash('sha1').update(original.trim().toLowerCase()).digest('hex').slice(0, 10);
  return `xe${h}x`;
}

function isSlotWord(w: string): boolean {
  return w === GENERIC_SLOT || /^xe[0-9a-f]{10}x$/.test(w);
}

/**
 * Normalize text for verbatim comparison. Each masked entity — whether it
 * appears as its original value or as a known placeholder — becomes an
 * IDENTITY token derived from the original, so renumbered placeholders and
 * restored names still match, but a quote that swaps one party's clause
 * onto another party's name (or another amount/date) does NOT verify.
 * Placeholders the mapping can't resolve become a generic wildcard, used
 * only by the fallback pass in quoteAppearsIn.
 */
function normalize(s: string, mappings: EntityMapping[] | undefined, mode: 'identity' | 'generic'): string {
  let out = s;
  if (mappings) {
    const byLen = [...mappings].sort((a, b) => b.original.length - a.original.length);
    for (const m of byLen) {
      if (m.original.length < 3) continue;
      const tok = mode === 'identity' ? identToken(m.original) : GENERIC_SLOT;
      out = out.replace(new RegExp(escapeRe(m.original), 'gi'), ` ${tok} `);
      out = out.split(m.placeholder).join(` ${tok} `);
    }
  }
  out = out.replace(/\[[A-Z]+_\d+\]/g, ` ${GENERIC_SLOT} `);
  out = out.toLowerCase();
  // punctuation → space (keeps words separate); preserves Unicode letters
  out = out.replace(/[^\p{L}\p{N} ]+/gu, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  // dedupe only IDENTICAL adjacent slot tokens (repetition), never distinct
  // entities — each slot stays a space-delimited word, so "slot shall" can
  // never fuse into "slotshall" and let a spliced quote skip text
  out = out.replace(/\b(xslotx|xe[0-9a-f]{10}x)\b(?: \1\b)+/g, '$1');
  return out;
}

/** Real (non-slot) content of a normalized quote — guards against quotes
 *  made up entirely of masked name slots, which would wildcard-match anything. */
function meaningfulLength(normalizedQuote: string): number {
  return normalizedQuote.split(' ').filter((w) => w && !isSlotWord(w)).join('').length;
}

const MIN_MEANINGFUL = 6;

/** Fetch the text a citation must quote from. */
function sourceText(db: Database.Database, c: Citation): string | null {
  switch (c.sourceType) {
    case 'provision': {
      const row = db.prepare(`SELECT heading, text FROM provisions WHERE id = ?`).get(c.sourceId) as
        | { heading: string; text: string }
        | undefined;
      return row ? `${row.heading}\n${row.text}` : null;
    }
    case 'document': {
      const row = db.prepare(`SELECT title, content FROM documents WHERE id = ?`).get(c.sourceId) as
        | { title: string; content: string }
        | undefined;
      return row ? `${row.title}\n${row.content}` : null;
    }
    case 'comment': {
      const row = db.prepare(`SELECT text FROM comments WHERE id = ?`).get(c.sourceId) as { text: string } | undefined;
      return row?.text ?? null;
    }
    case 'side_letter': {
      const row = db
        .prepare(
          `SELECT d.title, d.content FROM side_letters s JOIN documents d ON d.id = s.document_id WHERE s.id = ? OR s.document_id = ?`,
        )
        .get(c.sourceId, c.sourceId) as { title: string; content: string } | undefined;
      return row ? `${row.title}\n${row.content}` : null;
    }
    case 'obligation': {
      const row = db.prepare(`SELECT summary, source_clause FROM obligations WHERE id = ?`).get(c.sourceId) as
        | { summary: string; source_clause: string }
        | undefined;
      return row ? `${row.summary}\n${row.source_clause}` : null;
    }
    case 'precedent': {
      const row = db.prepare(`SELECT title, text FROM precedents WHERE id = ?`).get(c.sourceId) as
        | { title: string; text: string }
        | undefined;
      return row ? `${row.title}\n${row.text}` : null;
    }
  }
}

/** Does `quote` appear in `source` (whitespace-normalized, masked entity
 *  slots treated as wildcards)? The reusable core of citation verification. */
export function quoteAppearsIn(source: string, quote: string, mappings?: EntityMapping[]): boolean {
  if (!quote || quote.trim().length === 0) return false;
  const nq = normalize(quote, mappings, 'identity');
  // a quote that's only masked name slots (no real legal language) would
  // wildcard-match any source mentioning that party — reject it
  if (meaningfulLength(nq) < MIN_MEANINGFUL) return false;
  // strict pass: entity slots must match by IDENTITY
  const ns = normalize(source, mappings, 'identity');
  if (ns.includes(nq)) return true;
  // fallback: only when the quote carries a placeholder the mapping can't
  // resolve (model invented/renumbered beyond the map). ONLY that slot
  // becomes a wildcard — every resolvable entity still has to match by
  // identity, so one invented token can't launder a wrong-party quote.
  if (nq.includes(GENERIC_SLOT)) {
    const pattern = nq
      .split(' ')
      .map((w) => (w === GENERIC_SLOT ? '(?:xslotx|xe[0-9a-f]{10}x)' : escapeRe(w)))
      .join(' ');
    return new RegExp(pattern).test(ns);
  }
  return false;
}

/** Verify one citation: the quote must appear (whitespace-normalized, with
 *  masked entity slots treated as wildcards) in the cited source. */
export function verifyCitation(db: Database.Database, c: Citation, mappings?: EntityMapping[]): boolean {
  if (!c.quote || c.quote.trim().length === 0) return false;
  const text = sourceText(db, c);
  if (text === null) return false;
  return quoteAppearsIn(text, c.quote, mappings);
}

/**
 * Deep-walk a structured response, find every citation-shaped object, and
 * mark it with a `verified` flag in place. Returns the tally.
 */
export function verifyCitationsDeep(
  db: Database.Database,
  value: unknown,
  mappings?: EntityMapping[],
): { total: number; verified: number } {
  let total = 0;
  let verified = 0;

  function isCitationShaped(v: unknown): v is Citation {
    return (
      v !== null &&
      typeof v === 'object' &&
      typeof (v as Citation).sourceType === 'string' &&
      typeof (v as Citation).sourceId === 'string' &&
      typeof (v as Citation).quote === 'string'
    );
  }

  function walk(v: unknown): void {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      if (isCitationShaped(v)) {
        total += 1;
        const ok = verifyCitation(db, v, mappings);
        (v as VerifiedCitation).verified = ok;
        if (ok) verified += 1;
        return;
      }
      for (const child of Object.values(v as Record<string, unknown>)) walk(child);
    }
  }

  walk(value);
  return { total, verified };
}
