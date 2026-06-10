/**
 * MFN compendium engine.
 *
 * The most-favored-nations machinery nobody enjoys doing by hand: collect
 * every side-letter provision granted in a fund, work out which investors
 * are eligible to elect (commitment threshold parsed from the fund's own
 * MFN clause), compute the election deadline, and classify each provision
 * as electable vs excluded as recipient-specific (legal/tax/regulatory) —
 * the one judgment call, made by the frontier model with verbatim
 * citations, through the same gateway as everything else.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { callStructured } from '../ai/claude.js';
import { citationSchema, type Citation } from './citations.js';
import { addDays } from './deadlines.js';

// ── Deterministic assembly ───────────────────────────────────────────────

export interface MfnBasis {
  sourceType: 'obligation' | 'provision';
  sourceId: string;
  sourceClause: string;
  thresholdUsd: number | null;
  windowDays: number | null;
}

export interface SideLetterProvision {
  provisionId: string;
  documentId: string;
  documentTitle: string;
  granteeId: string;
  granteeName: string;
  granteeCommitmentUsd: number | null;
  topic: string;
  heading: string;
  text: string;
}

export interface Elector {
  investorId: string;
  name: string;
  type: string;
  jurisdiction: string;
  commitmentUsd: number;
}

export interface CompendiumData {
  fundId: string;
  fundName: string;
  basis: MfnBasis | null;
  provisions: SideLetterProvision[];
  electors: Elector[];
}

const WORD_NUMBERS: Record<string, number> = {
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty-five': 45,
  sixty: 60,
  ninety: 90,
};

export function parseThresholdUsd(clause: string): number | null {
  const m = clause.match(/\$\s?([\d,]+)(?:\s?(million|billion))?/i);
  if (!m) return null;
  let n = Number.parseInt(m[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  if (m[2]?.toLowerCase() === 'million') n *= 1_000_000;
  if (m[2]?.toLowerCase() === 'billion') n *= 1_000_000_000;
  return n;
}

export function parseWindowDays(clause: string): number | null {
  const numeric = clause.match(/within\s+[\w\- ]*\((\d+)\)\s+days/i);
  if (numeric) return Number.parseInt(numeric[1], 10);
  const bare = clause.match(/within\s+(\d+)\s+days/i);
  if (bare) return Number.parseInt(bare[1], 10);
  const word = clause.match(/within\s+([a-z\-]+)\s+days/i);
  if (word) return WORD_NUMBERS[word[1].toLowerCase()] ?? null;
  return null;
}

/** Find the fund-wide MFN clause: prefer a fund-level obligation, fall back
 *  to an MFN-topic provision in the fund's LPA. */
export function findMfnBasis(db: Database.Database, fundId: string): MfnBasis | null {
  const obligation = db
    .prepare(
      `SELECT id, source_clause, notice_days FROM obligations
       WHERE fund_id = ? AND type = 'mfn'
       ORDER BY CASE WHEN investor_id IS NULL THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(fundId) as { id: string; source_clause: string; notice_days: number | null } | undefined;
  if (obligation) {
    return {
      sourceType: 'obligation',
      sourceId: obligation.id,
      sourceClause: obligation.source_clause,
      thresholdUsd: parseThresholdUsd(obligation.source_clause),
      // the clause excerpt may omit the window sentence — the extracted
      // notice_days column carries it
      windowDays: parseWindowDays(obligation.source_clause) ?? obligation.notice_days,
    };
  }
  const provision = db
    .prepare(
      `SELECT p.id, p.text FROM provisions p JOIN documents d ON d.id = p.document_id
       WHERE d.fund_id = ? AND d.type = 'lpa' AND p.topic = 'mfn'
       ORDER BY d.status = 'closed' DESC LIMIT 1`,
    )
    .get(fundId) as { id: string; text: string } | undefined;
  if (provision) {
    return {
      sourceType: 'provision',
      sourceId: provision.id,
      sourceClause: provision.text,
      thresholdUsd: parseThresholdUsd(provision.text),
      windowDays: parseWindowDays(provision.text),
    };
  }
  return null;
}

export function assembleCompendiumData(db: Database.Database, fundId: string): CompendiumData {
  const fund = db.prepare(`SELECT id, name FROM funds WHERE id = ?`).get(fundId) as { id: string; name: string } | undefined;
  if (!fund) throw new Error(`Unknown fund: ${fundId}`);

  const basis = findMfnBasis(db, fundId);

  const provisions = db
    .prepare(
      `SELECT p.id AS provisionId, d.id AS documentId, d.title AS documentTitle,
              i.id AS granteeId, i.name AS granteeName, p.topic, p.heading, p.text,
              c.amount_usd AS granteeCommitmentUsd
       FROM provisions p
       JOIN documents d ON d.id = p.document_id
       JOIN investors i ON i.id = d.investor_id
       LEFT JOIN commitments c ON c.fund_id = d.fund_id AND c.investor_id = i.id
       WHERE d.fund_id = ? AND d.type = 'side_letter'
       ORDER BY i.name, p.position`,
    )
    .all(fundId) as SideLetterProvision[];

  const threshold = basis?.thresholdUsd ?? 0;
  const electors = db
    .prepare(
      `SELECT i.id AS investorId, i.name, i.type, i.jurisdiction, c.amount_usd AS commitmentUsd
       FROM commitments c JOIN investors i ON i.id = c.investor_id
       WHERE c.fund_id = ? AND c.amount_usd >= ?
       ORDER BY c.amount_usd DESC`,
    )
    .all(fundId, threshold) as Elector[];

  return { fundId, fundName: fund.name, basis, provisions, electors };
}

// ── Classification (the one frontier call) ───────────────────────────────

const classificationSchema = z.object({
  classifications: z.array(
    z.object({
      provisionId: z.string(),
      classification: z
        .enum(['electable', 'excluded_recipient_specific'])
        .describe('excluded_recipient_specific = tied to the recipient\'s particular legal, tax, regulatory or internal-policy circumstances'),
      rationale: z.string().describe('One sentence: why this provision is electable or excluded'),
      citation: citationSchema,
    }),
  ),
});

export interface CompendiumEntry extends SideLetterProvision {
  classification: 'electable' | 'excluded_recipient_specific';
  rationale: string;
  citation: Citation;
  electableBy: string[];
}

export interface Compendium {
  fundId: string;
  fundName: string;
  basis: MfnBasis | null;
  thresholdUsd: number | null;
  windowDays: number | null;
  deliveryDate: string | null;
  electionDeadline: string | null;
  electors: Elector[];
  entries: CompendiumEntry[];
  citationsVerified: { total: number; verified: number };
}

export async function buildCompendium(
  db: Database.Database,
  opts: { fundId: string; deliveryDate?: string },
): Promise<Compendium> {
  const data = assembleCompendiumData(db, opts.fundId);
  if (data.provisions.length === 0) {
    throw new Error('No executed side-letter provisions found for this fund.');
  }
  if (opts.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(opts.deliveryDate)) {
    throw new Error('deliveryDate must be YYYY-MM-DD');
  }

  const block = data.provisions
    .map(
      (p) =>
        `[sourceType: provision, sourceId: ${p.provisionId}] granted to: ${p.granteeName} (${p.topic})\n${p.heading}\n"${p.text}"`,
    )
    .join('\n\n');

  const result = await callStructured({
    stage: 'mfn.classify',
    scopeFundId: opts.fundId,
    system: `You are preparing a most-favored-nations side letter compendium for a fund sponsor. Classify EVERY provision below as 'electable' (other eligible investors may elect its benefit) or 'excluded_recipient_specific' (tied to the recipient's particular legal, tax, regulatory or internal-policy circumstances — e.g. a development-finance institution's statutory mandate, an insurer's solvency regime, a specific investor's sanctions policy). Market convention: economic and information rights are usually electable; status-based carve-outs are usually excluded. One classification per provision, in the order given. The citation must point at the provision's own sourceId with a verbatim quote from it.`,
    user: `FUND: ${data.fundName}\nMFN BASIS CLAUSE: "${data.basis?.sourceClause ?? 'not located — classify on market convention'}"\n\nSIDE LETTER PROVISIONS:\n\n${block}`,
    schema: classificationSchema,
    maxTokens: 6_000,
  });

  const byId = new Map(result.data.classifications.map((c) => [c.provisionId, c]));
  const entries: CompendiumEntry[] = data.provisions.map((p) => {
    const c = byId.get(p.provisionId);
    const electableBy =
      c?.classification === 'electable'
        ? data.electors.filter((e) => e.investorId !== p.granteeId).map((e) => e.name)
        : [];
    return {
      ...p,
      classification: c?.classification ?? 'excluded_recipient_specific',
      rationale: c?.rationale ?? 'Not classified by the model — defaulted to excluded (conservative).',
      citation: c?.citation ?? { sourceType: 'provision', sourceId: p.provisionId, quote: '' },
      electableBy,
    };
  });

  const deliveryDate = opts.deliveryDate ?? null;
  const electionDeadline =
    deliveryDate && data.basis?.windowDays != null ? addDays(deliveryDate, data.basis.windowDays) : null;

  return {
    fundId: data.fundId,
    fundName: data.fundName,
    basis: data.basis,
    thresholdUsd: data.basis?.thresholdUsd ?? null,
    windowDays: data.basis?.windowDays ?? null,
    deliveryDate,
    electionDeadline,
    electors: data.electors,
    entries,
    citationsVerified: result.citations,
  };
}
