/**
 * Citation contract — every AI assertion must quote its source, and the
 * quote must actually appear in the cited row. Verification runs AFTER
 * de-anonymization so restored names compare against real source text.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { EntityMapping } from '../privacy/anonymize.js';

export const citationSchema = z.object({
  sourceType: z.enum(['provision', 'document', 'comment', 'side_letter', 'obligation']),
  sourceId: z.string(),
  quote: z.string(),
});

export type Citation = z.infer<typeof citationSchema>;

export interface VerifiedCitation extends Citation {
  verified: boolean;
}

const SLOT = 'XSLOTX'; // wildcard marker for a masked entity slot

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize text for verbatim comparison. Masked entity slots are treated as
 * wildcards: both `[INVESTOR_3]`-style placeholders and the original names
 * they map to collapse to a single marker. This lets a quote verify against
 * its source even when the frontier model renumbered a placeholder or the
 * quote carries a restored name while the source still holds a placeholder
 * (or vice versa) — we verify the *legal language*, not the name slots,
 * which are validated separately by the mapping itself.
 */
function normalize(s: string, mappings?: EntityMapping[]): string {
  let out = s;
  if (mappings) {
    const byLen = [...mappings].sort((a, b) => b.original.length - a.original.length);
    for (const m of byLen) {
      if (m.original.length < 3) continue;
      out = out.replace(new RegExp(escapeRe(m.original), 'gi'), SLOT);
    }
  }
  out = out.replace(/\[[A-Z]+_\d+\]/g, SLOT);
  out = out.replace(/\s+/g, ' ').trim().toLowerCase();
  const slot = SLOT.toLowerCase();
  out = out.replace(new RegExp('\\s*' + slot + '(?:\\s*' + slot + ')*\\s*', 'g'), slot);
  return out;
}

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
  }
}

/** Does `quote` appear in `source` (whitespace-normalized, masked entity
 *  slots treated as wildcards)? The reusable core of citation verification. */
export function quoteAppearsIn(source: string, quote: string, mappings?: EntityMapping[]): boolean {
  if (!quote || quote.trim().length === 0) return false;
  return normalize(source, mappings).includes(normalize(quote, mappings));
}

/** Verify one citation: the quote must appear (whitespace-normalized, with
 *  masked entity slots treated as wildcards) in the cited source. */
export function verifyCitation(db: Database.Database, c: Citation, mappings?: EntityMapping[]): boolean {
  if (!c.quote || c.quote.trim().length === 0) return false;
  const text = sourceText(db, c);
  if (text === null) return false;
  return normalize(text, mappings).includes(normalize(c.quote, mappings));
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
