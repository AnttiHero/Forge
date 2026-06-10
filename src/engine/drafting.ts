/**
 * Drafting pipeline — the four specialized roles from the demo, run as
 * sequential stages over one sticky anonymization run:
 *
 *   1. insight-capturer  — parse the term sheet into commercial terms, then
 *                          mine prior-fund provisions and investor comments
 *   2. extractor         — structure model-document language into slots
 *   3. drafter           — draft the new sections, citing every source
 *   4. feedback-integrator — separate entry point: fold lawyer feedback in
 *
 * Progress streams through engine/progress.ts → SSE.
 */

import { z } from 'zod';
import { getDb, genId } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';
import { embedAll } from '../search/embeddings.js';
import { releaseRun } from '../ai/gateway.js';
import { createRun, emit, finishRun, failRun } from './progress.js';

const MAX_TERMS = 6;

const termsSchema = z.object({
  terms: z
    .array(
      z.object({
        key: z.string().describe('Short name, e.g. "Management Fee"'),
        topic: z
          .string()
          .describe('One of: geographic, mfn, co_invest, fees, distributions, reporting, key_person, transfer, excuse, advisory_board, confidentiality, capital_calls, indemnification, other'),
        description: z.string().describe('The commercial term as stated in the term sheet'),
      }),
    )
    .describe(`The principal commercial terms, most important first, at most ${MAX_TERMS}`),
});

const insightsSchema = z.object({
  insights: z.array(
    z.object({
      term: z.string(),
      note: z.string().describe('What prior funds and investor comments teach about how to draft this term'),
      citations: z.array(citationSchema),
    }),
  ),
});

const structuresSchema = z.object({
  structures: z.array(
    z.object({
      term: z.string(),
      slots: z.array(
        z.object({
          name: z.string().describe('Variable slot from the model language, e.g. "[PERCENTAGE]"'),
          value: z.string().describe('The value this fund\'s term sheet implies for the slot'),
        }),
      ),
      modelCitations: z.array(citationSchema),
    }),
  ),
});

const sectionsSchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string().describe('Section heading, e.g. "Section 7.1 — Management Fee"'),
      topic: z.string(),
      text: z.string().describe('Complete operative section text'),
      citations: z.array(citationSchema),
    }),
  ),
});

export interface DraftingResult {
  documentId: string;
  sections: Array<{ provisionId: string; heading: string; topic: string; text: string; citations: unknown[] }>;
  insights: z.infer<typeof insightsSchema>['insights'];
  citationsVerified: { total: number; verified: number };
}

export function startDraftingPipeline(fundId: string, termSheetText: string): string {
  const runId = genId('run');
  createRun(runId, 'drafting');
  void executePipeline(runId, fundId, termSheetText)
    .then((result) => finishRun(runId, result))
    .catch((err) => failRun(runId, err instanceof Error ? err.message : String(err)))
    .finally(() => releaseRun(runId));
  return runId;
}

async function executePipeline(runId: string, fundId: string, termSheetText: string): Promise<DraftingResult> {
  const db = getDb();
  const fund = db.prepare(`SELECT id, name FROM funds WHERE id = ?`).get(fundId) as { id: string; name: string } | undefined;
  if (!fund) throw new Error(`Unknown fund: ${fundId}`);

  // ── Stage 1a: parse the term sheet ──────────────────────────────────
  emit(runId, 'insight-capturer', 'start', 'Parsing term sheet into commercial terms');
  const parsed = await callStructured({
    stage: 'drafting.terms',
    runId,
    system: 'Parse this fund term sheet into its principal commercial terms. Only output terms actually stated.',
    user: termSheetText,
    schema: termsSchema,
    maxTokens: 4_000,
    effort: 'medium',
  });
  const terms = parsed.data.terms.slice(0, MAX_TERMS);
  emit(runId, 'insight-capturer', 'info', `${terms.length} commercial terms identified`);

  // ── Stage 1b: mine prior art ────────────────────────────────────────
  const priorBundles: string[] = [];
  for (const term of terms) {
    const priorHits = await hybridSearch(db, {
      query: `${term.key} ${term.description}`,
      table: 'provisions',
      docStatus: 'closed',
      topK: 2,
    });
    const commentRows = db
      .prepare(
        `SELECT c.id, c.text, i.name FROM comments c JOIN investors i ON i.id = c.investor_id
         WHERE c.provision_topic = ? LIMIT 3`,
      )
      .all(term.topic) as Array<{ id: string; text: string; name: string }>;
    const prior = priorHits
      .map((h) => `[sourceType: provision, sourceId: ${h.id}] ${h.heading}\n"${h.text}"`)
      .join('\n');
    const comments = commentRows
      .map((c) => `[sourceType: comment, sourceId: ${c.id}] ${c.name}: "${c.text}"`)
      .join('\n');
    priorBundles.push(`TERM: ${term.key} — ${term.description}\nPRIOR FUND PROVISIONS:\n${prior || 'none'}\nINVESTOR COMMENTS:\n${comments || 'none'}`);
  }
  const insights = await callStructured({
    stage: 'drafting.insights',
    runId,
    system:
      'You are the insight-capturer of a drafting pipeline. For each term, distill what the prior-fund provisions and investor comments teach about how this sponsor should draft it now. Citation quotes must be verbatim from the provided sources.',
    user: priorBundles.join('\n\n────────\n\n'),
    schema: insightsSchema,
    maxTokens: 8_000,
  });
  emit(runId, 'insight-capturer', 'done', `${insights.data.insights.length} insights captured`);

  // ── Stage 2: extractor — structure model language ───────────────────
  emit(runId, 'extractor', 'start', 'Structuring model-document language');
  const modelBundles: string[] = [];
  for (const term of terms) {
    const modelHits = await hybridSearch(db, {
      query: `${term.key} ${term.description}`,
      table: 'provisions',
      docStatus: 'model',
      topic: term.topic === 'other' ? undefined : term.topic,
      topK: 3,
    });
    const model = modelHits.map((h) => `[sourceType: provision, sourceId: ${h.id}] ${h.heading}\n"${h.text}"`).join('\n\n');
    modelBundles.push(`TERM: ${term.key} — ${term.description}\nMODEL LANGUAGE:\n${model || 'none'}`);
  }
  const structures = await callStructured({
    stage: 'drafting.extract',
    runId,
    system:
      'You are the extractor of a drafting pipeline. For each term, identify the bracketed variable slots in the model language (e.g. [PERCENTAGE], [NUMBER], [THRESHOLD]) and the value the term sheet implies for each. Cite the model provisions you used; quotes verbatim.',
    user: modelBundles.join('\n\n────────\n\n'),
    schema: structuresSchema,
    maxTokens: 8_000,
  });
  emit(runId, 'extractor', 'done', `${structures.data.structures.length} model structures extracted`);

  // ── Stage 3: drafter ────────────────────────────────────────────────
  emit(runId, 'drafter', 'start', 'Drafting sections');
  const drafted = await callStructured({
    stage: 'drafting.draft',
    runId,
    system: `You are the drafter of a drafting pipeline for ${fund.name}. Draft one complete LPA section per term: start from the model structure, fill every slot with the extracted value, and apply the insights. Sections must be complete operative legal text. Cite every model provision, prior provision and comment that shaped each section; quotes verbatim from those sources.`,
    user: `TERMS:\n${terms.map((t) => `- ${t.key} (${t.topic}): ${t.description}`).join('\n')}\n\nMODEL STRUCTURES:\n${JSON.stringify(structures.data.structures, null, 2)}\n\nINSIGHTS:\n${JSON.stringify(insights.data.insights, null, 2)}`,
    schema: sectionsSchema,
    maxTokens: 16_000,
  });
  emit(runId, 'drafter', 'done', `${drafted.data.sections.length} sections drafted`);

  // ── Persist as a draft document ─────────────────────────────────────
  emit(runId, 'feedback-integrator', 'start', 'Saving draft into the ontology');
  const documentId = genId('doc');
  db.prepare(`INSERT INTO documents (id, fund_id, type, status, title, content) VALUES (?, ?, 'lpa', 'draft', ?, ?)`).run(
    documentId,
    fundId,
    `${fund.name} — Engine Working Draft (${runId})`,
    drafted.data.sections.map((s) => `${s.heading}\n\n${s.text}`).join('\n\n'),
  );
  const insertProvision = db.prepare(
    `INSERT INTO provisions (id, document_id, topic, heading, text, position) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const sections = drafted.data.sections.map((s, i) => {
    const provisionId = genId('p');
    insertProvision.run(provisionId, documentId, s.topic, s.heading, s.text, i + 1);
    return { provisionId, heading: s.heading, topic: s.topic, text: s.text, citations: s.citations };
  });
  await embedAll(
    db,
    sections.map((s) => ({ ownerType: 'provision' as const, ownerId: s.provisionId, text: `${s.heading}\n${s.text}` })),
  );
  emit(runId, 'feedback-integrator', 'done', `Draft saved as ${documentId} — ready for feedback`);

  return {
    documentId,
    sections,
    insights: insights.data.insights,
    citationsVerified: {
      total: insights.citations.total + structures.citations.total + drafted.citations.total,
      verified: insights.citations.verified + structures.citations.verified + drafted.citations.verified,
    },
  };
}

// ── Stage 4: feedback-integrator (separate entry point) ────────────────

const revisionSchema = z.object({
  revisedText: z.string().describe('The complete revised section text'),
  changeSummary: z.string().describe('What changed and why, 1-3 sentences'),
  citations: z.array(citationSchema),
});

export interface FeedbackResult extends z.infer<typeof revisionSchema> {
  provisionId: string;
  citationsVerified: { total: number; verified: number };
}

export async function integrateFeedback(provisionId: string, feedback: string): Promise<FeedbackResult> {
  const db = getDb();
  const provision = db
    .prepare(`SELECT p.id, p.document_id, p.topic, p.heading, p.text FROM provisions p WHERE p.id = ?`)
    .get(provisionId) as { id: string; document_id: string; topic: string; heading: string; text: string } | undefined;
  if (!provision) throw new Error(`Unknown provision: ${provisionId}`);

  const modelHits = await hybridSearch(db, {
    query: `${provision.topic} ${feedback}`,
    table: 'provisions',
    docStatus: 'model',
    topK: 2,
  });
  const model = modelHits.map((h) => `[sourceType: provision, sourceId: ${h.id}] ${h.heading}\n"${h.text}"`).join('\n\n');

  const result = await callStructured({
    stage: 'drafting.feedback',
    system:
      'You are the feedback-integrator of a drafting pipeline. Revise the section to implement the lawyer\'s feedback, pulling in model language where it helps. Cite the current section and any model provisions used; quotes verbatim.',
    user: `CURRENT SECTION (${provision.heading}) [sourceType: provision, sourceId: ${provision.id}]:\n"${provision.text}"\n\nLAWYER FEEDBACK:\n${feedback}\n\nMODEL LANGUAGE:\n${model || 'none'}`,
    schema: revisionSchema,
    maxTokens: 8_000,
  });

  db.prepare(`UPDATE provisions SET text = ? WHERE id = ?`).run(result.data.revisedText, provisionId);

  return { ...result.data, provisionId, citationsVerified: result.citations };
}
