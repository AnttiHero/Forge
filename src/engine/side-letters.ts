/**
 * Side letter generation — three complete drafts following the reuse
 * hierarchy: (1) exact model language, (2) adapted precedent, (3) fresh
 * drafting. Retrieval scores computed locally decide which tier each agreed
 * term naturally supports; Fable 5 assembles the three drafts with
 * per-clause tier annotations and citations.
 */

import { z } from 'zod';
import { getDb } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';

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

  // Per-term retrieval: model library + precedent side letters, tiered by score
  const termBundles: string[] = [];
  const termRetrieval: Array<{ term: string; suggestedTier: string }> = [];
  for (const term of opts.agreedTerms) {
    const modelHits = await hybridSearch(db, { query: term, table: 'provisions', docStatus: 'model', topK: 2 });
    const precedentHits = await hybridSearch(db, { query: term, table: 'provisions', docType: 'side_letter', topK: 2 });

    const bestModel = modelHits[0]?.score ?? 0;
    const bestPrecedent = precedentHits[0]?.score ?? 0;
    const suggestedTier =
      bestModel >= TIER1_THRESHOLD ? 'model_language' : Math.max(bestModel, bestPrecedent) >= TIER2_THRESHOLD ? 'adapted_precedent' : 'fresh_drafting';
    termRetrieval.push({ term, suggestedTier });

    const fmt = (hits: typeof modelHits): string =>
      hits.map((h) => `[sourceType: provision, sourceId: ${h.id}] ${h.heading} (score ${h.score.toFixed(2)})\n"${h.text}"`).join('\n\n') || 'none';
    termBundles.push(
      `AGREED TERM: "${term}"\nsuggested tier from retrieval: ${suggestedTier}\nMODEL LANGUAGE CANDIDATES:\n${fmt(modelHits)}\nPRECEDENT SIDE LETTER CANDIDATES:\n${fmt(precedentHits)}`,
    );
  }

  const result = await callStructured({
    stage: 'side-letters.generate',
    system: `You draft side letters for a fund sponsor. Produce EXACTLY three complete drafts implementing all agreed terms, one per reuse strategy: (1) model_language — stay as close to the firm's model provisions as possible, adapting bracketed variables only; (2) adapted_precedent — adapt this investor's (or comparable investors') precedent clauses; (3) fresh_drafting — draft freely for the cleanest commercial outcome. In every draft, each clause states its actual tier and cites its sources; a model_language draft may still need fresh_drafting for a term with no model candidate (the retrieval-suggested tier tells you what's available). Citation quotes must be copied verbatim from the provided sources. Address the letter from the General Partner of ${fund.name} to ${investor.name}.`,
    user: `FUND: ${fund.name}\nINVESTOR: ${investor.name} (${investor.type}, ${investor.jurisdiction})\n\n${termBundles.join('\n\n────────\n\n')}`,
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
