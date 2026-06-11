/**
 * Side letter generation — three complete drafts following the reuse
 * hierarchy: (1) exact model language, (2) adapted precedent, (3) fresh
 * drafting. Retrieval scores computed locally decide which tier each agreed
 * term naturally supports; Fable 5 assembles the three drafts with
 * per-clause tier annotations and citations.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getDb, genId } from '../db/db.js';
import { embedAll } from '../search/embeddings.js';
import { promotePrecedent } from './precedent.js';
import { extractObligations, type ExtractedObligation } from './obligations.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';
import { markPrecedentsUsed, precedentPromptBlock, searchPrecedents } from './precedent.js';
import { investorProfile } from '../ai/gateway.js';

const TIER1_THRESHOLD = 0.75;
const TIER2_THRESHOLD = 0.3;

const draftsSchema = z.object({
  drafts: z
    .array(
      z.object({
        label: z.enum(['model_language', 'adapted_precedent', 'fresh_drafting']),
        rationale: z.string().describe('One sentence on when to pick this draft'),
        clauses: z.array(
          z.object({
            term: z.string().describe('The agreed term this clause implements'),
            tier: z.enum(['model_language', 'adapted_precedent', 'fresh_drafting']).describe('Where this clause language came from'),
            text: z.string().describe('Complete clause text'),
            citations: z.array(citationSchema),
          }),
        ),
      }),
    )
    .describe('Exactly three drafts, one per label'),
});

export type SideLetterDrafts = z.infer<typeof draftsSchema> & {
  investorId: string;
  fundId: string;
  termRetrieval: Array<{ term: string; suggestedTier: string }>;
  citationsVerified: { total: number; verified: number };
};

export async function generateSideLetterDrafts(opts: {
  fundId: string;
  investorId: string;
  agreedTerms: string[];
}): Promise<SideLetterDrafts> {
  const db = getDb();
  const investor = db.prepare(`SELECT id, name, type, jurisdiction FROM investors WHERE id = ?`).get(opts.investorId) as
    | { id: string; name: string; type: string; jurisdiction: string }
    | undefined;
  const fund = db.prepare(`SELECT id, name FROM funds WHERE id = ?`).get(opts.fundId) as { id: string; name: string } | undefined;
  if (!investor || !fund) throw new Error('Unknown investor or fund');
  if (opts.agreedTerms.length === 0) throw new Error('At least one agreed term required');

  // Per-term retrieval: model library + precedent side letters + weighted
  // house precedent (the compounding loop), tiered by score
  const termBundles: string[] = [];
  const termRetrieval: Array<{ term: string; suggestedTier: string }> = [];
  const usedPrecedentIds = new Set<string>();
  for (const term of opts.agreedTerms) {
    const modelHits = await hybridSearch(db, { query: term, table: 'provisions', docStatus: 'model', topK: 2 });
    const precedentHits = await hybridSearch(db, { query: term, table: 'provisions', docType: 'side_letter', topK: 2 });
    const houseHits = await searchPrecedents(db, { query: term, topK: 2 });
    for (const h of houseHits) usedPrecedentIds.add(h.id);

    const bestModel = modelHits[0]?.score ?? 0;
    const bestPrecedent = precedentHits[0]?.score ?? 0;
    const suggestedTier =
      bestModel >= TIER1_THRESHOLD ? 'model_language' : Math.max(bestModel, bestPrecedent) >= TIER2_THRESHOLD ? 'adapted_precedent' : 'fresh_drafting';
    termRetrieval.push({ term, suggestedTier });

    const fmt = (hits: typeof modelHits): string =>
      hits.map((h) => `[sourceType: provision, sourceId: ${h.id}] ${h.heading} (score ${h.score.toFixed(2)})\n"${h.text}"`).join('\n\n') || 'none';
    termBundles.push(
      `AGREED TERM: "${term}"\nsuggested tier from retrieval: ${suggestedTier}\nMODEL LANGUAGE CANDIDATES:\n${fmt(modelHits)}\nPRECEDENT SIDE LETTER CANDIDATES:\n${fmt(precedentHits)}\n${precedentPromptBlock(houseHits) || 'HOUSE PRECEDENT: none yet'}`,
    );
  }
  markPrecedentsUsed(db, [...usedPrecedentIds]);

  const result = await callStructured({
    stage: 'side-letters.generate',
    system: `You draft side letters for a fund sponsor. Produce EXACTLY three complete drafts implementing all agreed terms, one per reuse strategy: (1) model_language — stay as close to the firm's model provisions as possible, adapting bracketed variables only; (2) adapted_precedent — adapt this investor's (or comparable investors') precedent clauses; (3) fresh_drafting — draft freely for the cleanest commercial outcome. In every draft, each clause states its actual tier and cites its sources; a model_language draft may still need fresh_drafting for a term with no model candidate (the retrieval-suggested tier tells you what's available). Citation quotes must be copied verbatim from the provided sources. Address the letter from the General Partner of ${fund.name} to ${investor.name}.`,
    user: `FUND: ${fund.name}\nINVESTOR: ${investor.name} (${investorProfile(investor.type, investor.jurisdiction)})\n\n${termBundles.join('\n\n────────\n\n')}`,
    schema: draftsSchema,
    maxTokens: 16_000,
  });

  return {
    ...result.data,
    investorId: investor.id,
    fundId: fund.id,
    termRetrieval,
    citationsVerified: result.citations,
  };
}

// ── Execution — the lifecycle loop closes here ───────────────────────────

export interface ExecutedSideLetter {
  documentId: string;
  sideLetterId: string;
  title: string;
  provisionCount: number;
  obligations: ExtractedObligation[];
}

/**
 * A negotiated draft becomes part of the record: persisted as an executed
 * side-letter document linked to its investor, indexed for retrieval,
 * promoted to house precedent, and — the point of the whole register — its
 * ongoing obligations extracted so the next compendium, deadline run and
 * Q&A all see what was actually signed.
 */
export async function executeSideLetter(
  db: Database.Database,
  opts: {
    fundId: string;
    investorId: string;
    draft: { label: string; clauses: Array<{ term: string; tier: string; text: string }> };
    /** skip the (frontier) obligation extraction — tests */
    extract?: boolean;
  },
): Promise<ExecutedSideLetter> {
  const investor = db.prepare(`SELECT id, name FROM investors WHERE id = ?`).get(opts.investorId) as
    | { id: string; name: string }
    | undefined;
  const fund = db.prepare(`SELECT id, name FROM funds WHERE id = ?`).get(opts.fundId) as { id: string; name: string } | undefined;
  if (!investor || !fund) throw new Error('Unknown investor or fund');
  if (!opts.draft?.clauses?.length) throw new Error('Draft has no clauses');

  const documentId = genId('doc');
  const sideLetterId = genId('sl');
  const title = `Side Letter — ${investor.name} (${fund.name})`;
  const content = [title, '', ...opts.draft.clauses.flatMap((c, i) => [`Paragraph ${i + 1} — ${c.term}`, '', c.text, ''])].join('\n');

  // Idempotent on retry: if this exact letter is already on file (a prior
  // attempt that failed after the commit, or a double click), reuse it —
  // finishing the obligation extraction if that's the part that died.
  const existing = db
    .prepare(
      `SELECT d.id AS documentId, s.id AS sideLetterId FROM documents d
       JOIN side_letters s ON s.document_id = d.id
       WHERE d.fund_id = ? AND d.investor_id = ? AND d.type = 'side_letter' AND d.content = ?`,
    )
    .get(opts.fundId, opts.investorId, content) as { documentId: string; sideLetterId: string } | undefined;
  if (existing) {
    let obligations: ExtractedObligation[] = [];
    const haveObligations = (
      db.prepare(`SELECT COUNT(*) AS n FROM obligations WHERE source_document_id = ?`).get(existing.documentId) as { n: number }
    ).n;
    if (opts.extract !== false && haveObligations === 0) {
      obligations = (await extractObligations(existing.documentId)).obligations;
    }
    return {
      documentId: existing.documentId,
      sideLetterId: existing.sideLetterId,
      title,
      provisionCount: opts.draft.clauses.length,
      obligations,
    };
  }

  const insertDoc = db.prepare(
    `INSERT INTO documents (id, fund_id, type, status, investor_id, title, content) VALUES (?, ?, 'side_letter', 'closed', ?, ?, ?)`,
  );
  const insertProvision = db.prepare(
    `INSERT INTO provisions (id, document_id, topic, heading, text, position) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSideLetter = db.prepare(
    `INSERT INTO side_letters (id, fund_id, investor_id, document_id, agreed_terms_json) VALUES (?, ?, ?, ?, ?)`,
  );

  const provisionRows = opts.draft.clauses.map((c, i) => ({
    id: genId('p'),
    heading: `Paragraph ${i + 1} — ${c.term}`,
    topic: classifyClauseTopic(c.term, c.text),
    text: c.text,
    position: i + 1,
  }));

  db.transaction(() => {
    insertDoc.run(documentId, opts.fundId, investor.id, title, content);
    for (const p of provisionRows) insertProvision.run(p.id, documentId, p.topic, p.heading, p.text, p.position);
    insertSideLetter.run(sideLetterId, opts.fundId, investor.id, documentId, JSON.stringify(opts.draft.clauses.map((c) => c.term)));
  })();

  await embedAll(
    db,
    provisionRows.map((p) => ({ ownerType: 'provision' as const, ownerId: p.id, text: `${p.heading}\n${p.text}` })),
  );
  for (const p of provisionRows) {
    await promotePrecedent(db, {
      kind: 'side_letter_clause',
      topic: p.topic,
      title: `${title} — ${p.heading}`,
      text: p.text,
      sourceType: 'provision',
      sourceId: p.id,
      fundId: opts.fundId,
      weight: 1.2,
    });
  }

  let obligations: ExtractedObligation[] = [];
  if (opts.extract !== false) {
    obligations = (await extractObligations(documentId)).obligations;
  }

  return { documentId, sideLetterId, title, provisionCount: provisionRows.length, obligations };
}

/** Same keyword classifier the parser uses, for executed clause topics. */
function classifyClauseTopic(term: string, text: string): string {
  const hay = `${term} ${text}`.toLowerCase();
  if (/excus/.test(hay)) return 'excuse';
  if (/most favou?red|mfn|compendium/.test(hay)) return 'mfn';
  if (/notice|notify|business days prior/.test(hay)) return 'notice';
  if (/report|statement|annual|quarterly/.test(hay)) return 'reporting';
  if (/transfer|assign|pledge/.test(hay)) return 'transfer';
  if (/consent|approval/.test(hay)) return 'consent';
  if (/fee|carry|carried interest/.test(hay)) return 'fees';
  if (/co-?invest/.test(hay)) return 'co_invest';
  return 'other';
}
