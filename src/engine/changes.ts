/**
 * Change assessment — "the managing partner wants to expand the geographic
 * mandate to emerging markets." Reads the current provision, surfaces
 * market examples from the corpus, and offers a menu of alternatives.
 */

import { z } from 'zod';
import { getDb } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';

const assessmentSchema = z.object({
  currentReading: z.string().describe('What the current provision permits and prohibits, 2-4 sentences'),
  marketExamples: z.array(
    z.object({
      characterization: z.string().describe('How this example handles the issue'),
      citation: citationSchema,
    }),
  ),
  alternatives: z
    .array(
      z.object({
        label: z.string().describe('Short menu label, e.g. "Capped emerging-markets basket"'),
        draftText: z.string().describe('Complete replacement provision text, ready to drop in'),
        tradeoffs: z.string().describe('Who gains, who pushes back, expected LP reaction'),
        citations: z.array(citationSchema),
      }),
    )
    .describe('3 to 4 distinct alternatives, ordered most conservative first'),
});

export type ChangeAssessment = z.infer<typeof assessmentSchema> & {
  provisionId: string;
  citationsVerified: { total: number; verified: number };
  auditId: string;
};

export async function assessChange(provisionId: string, changeRequest: string): Promise<ChangeAssessment> {
  const db = getDb();
  const provision = db
    .prepare(
      `SELECT p.id, p.topic, p.heading, p.text, d.title AS doc_title, d.fund_id
       FROM provisions p JOIN documents d ON d.id = p.document_id WHERE p.id = ?`,
    )
    .get(provisionId) as
    | { id: string; topic: string; heading: string; text: string; doc_title: string; fund_id: string | null }
    | undefined;
  if (!provision) throw new Error(`Unknown provision: ${provisionId}`);

  // Market examples: model library + prior-fund LPAs + precedent side letters on the same ground
  const hits = await hybridSearch(db, {
    query: `${provision.topic} ${changeRequest}`,
    table: 'provisions',
    topK: 6,
  });
  const examples = hits
    .filter((h) => h.id !== provisionId)
    .map((h) => {
      const doc = db.prepare(`SELECT title, status, type FROM documents WHERE id = ?`).get(h.documentId) as {
        title: string;
        status: string;
        type: string;
      };
      return `[sourceType: provision, sourceId: ${h.id}] (${doc.type}, ${doc.status}) ${h.heading} — from ${doc.title}\n"${h.text}"`;
    })
    .join('\n\n');

  const result = await callStructured({
    stage: 'changes.assess',
    system: `You are a fund formation partner assessing a commercial change to a fund document. Read the current provision, characterize the market examples, and offer a menu of 3-4 concrete drafting alternatives. Every citation quote must be copied verbatim from the provided sources. draftText must be complete operative language in the style of the current provision, not a summary.`,
    user: `CURRENT PROVISION (${provision.heading}, from ${provision.doc_title}) [sourceType: provision, sourceId: ${provision.id}]:\n"${provision.text}"\n\nREQUESTED CHANGE:\n${changeRequest}\n\nMARKET EXAMPLES FROM THE FIRM'S CORPUS:\n\n${examples || 'none found'}`,
    schema: assessmentSchema,
    maxTokens: 8_000,
  });

  return { ...result.data, provisionId, citationsVerified: result.citations, auditId: result.auditId };
}
