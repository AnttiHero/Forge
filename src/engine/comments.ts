/**
 * Comment triage — investor comments organized by deal point, with AI
 * suggested resolutions citing model language and precedent. The lawyer's
 * judgment stays in the loop: accepting or editing a resolution is a pure
 * database write, never a model call.
 */

import { z } from 'zod';
import { getDb, genId } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';
import { markPrecedentsUsed, precedentPromptBlock, promotePrecedent, searchPrecedents } from './precedent.js';
import { investorProfile } from '../ai/gateway.js';

export interface TriagedComment {
  id: string;
  investorId: string;
  investorName: string;
  investorType: string;
  provisionTopic: string;
  text: string;
  status: string;
  suggestedResolution: string | null;
  suggestionCitations: unknown[] | null;
  resolutionText: string | null;
  resolvedBy: string | null;
}

export function listTriagedComments(fundId: string): Record<string, TriagedComment[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.investor_id AS investorId, i.name AS investorName, i.type AS investorType,
              c.provision_topic AS provisionTopic, c.text, c.status,
              c.suggested_resolution AS suggestedResolution, c.suggestion_citations_json AS citationsJson,
              c.resolution_text AS resolutionText, c.resolved_by AS resolvedBy
       FROM comments c JOIN investors i ON i.id = c.investor_id
       WHERE c.fund_id = ?
       ORDER BY c.provision_topic, i.name`,
    )
    .all(fundId) as Array<TriagedComment & { citationsJson: string | null }>;

  const grouped: Record<string, TriagedComment[]> = {};
  for (const row of rows) {
    const { citationsJson, ...rest } = row;
    const comment: TriagedComment = {
      ...rest,
      suggestionCitations: citationsJson ? (JSON.parse(citationsJson) as unknown[]) : null,
    };
    (grouped[comment.provisionTopic] ??= []).push(comment);
  }
  return grouped;
}

const suggestionSchema = z.object({
  dealPoint: z.string().describe('The deal point this comment raises, in a few words'),
  recommendedResolution: z
    .string()
    .describe('What the sponsor should do: accept / reject / compromise, with the reasoning'),
  draftResponseText: z.string().describe('Draft language or response the lawyer can send'),
  citations: z.array(citationSchema).describe('Sources for the recommendation — model provisions, precedent side letters, prior comments'),
});

export type CommentSuggestion = z.infer<typeof suggestionSchema> & {
  commentId: string;
  citationsVerified: { total: number; verified: number };
};

export async function suggestResolution(commentId: string): Promise<CommentSuggestion> {
  const db = getDb();
  const comment = db
    .prepare(
      `SELECT c.id, c.fund_id, c.provision_topic, c.text, i.id AS investor_id, i.name AS investor_name, i.type AS investor_type, i.jurisdiction
       FROM comments c JOIN investors i ON i.id = c.investor_id WHERE c.id = ?`,
    )
    .get(commentId) as
    | {
        id: string;
        fund_id: string;
        provision_topic: string;
        text: string;
        investor_id: string;
        investor_name: string;
        investor_type: string;
        jurisdiction: string;
      }
    | undefined;
  if (!comment) throw new Error(`Unknown comment: ${commentId}`);

  // Retrieval: model language on this topic + the investor's own precedent side letters + the current draft provision
  const modelHits = await hybridSearch(db, {
    query: `${comment.provision_topic} ${comment.text}`,
    table: 'provisions',
    docStatus: 'model',
    topK: 3,
  });
  const precedentRows = db
    .prepare(
      `SELECT p.id, p.heading, p.text FROM provisions p JOIN documents d ON d.id = p.document_id
       WHERE d.type = 'side_letter' AND d.investor_id = ?`,
    )
    .all(comment.investor_id) as Array<{ id: string; heading: string; text: string }>;
  const draftRows = db
    .prepare(
      `SELECT p.id, p.heading, p.text FROM provisions p JOIN documents d ON d.id = p.document_id
       WHERE d.fund_id = ? AND d.status = 'draft' AND p.topic = ?`,
    )
    .all(comment.fund_id, comment.provision_topic) as Array<{ id: string; heading: string; text: string }>;

  const block = (label: string, rows: Array<{ id: string; heading: string; text: string }>): string =>
    rows.length === 0
      ? `${label}: none`
      : `${label}:\n` + rows.map((r) => `[sourceType: provision, sourceId: ${r.id}] ${r.heading}\n"${r.text}"`).join('\n\n');

  // the compounding loop: what this firm's lawyers accepted before informs
  // what gets proposed now
  const housePrecedent = await searchPrecedents(db, {
    query: `${comment.provision_topic} ${comment.text}`,
    topic: comment.provision_topic,
    topK: 3,
  });

  const result = await callStructured({
    stage: 'comments.suggest',
    system: `You are a fund formation partner resolving an investor comment on a draft LPA. Recommend a resolution grounded in the firm's model language, this investor's own precedent, and — above all — how this firm's lawyers have actually resolved similar comments before (the house precedent block; higher weight means a lawyer stood behind it). Citation quotes must be copied verbatim from the provided sources. Be commercial: protect the sponsor while keeping the investor in the fund.`,
    user: `INVESTOR: ${comment.investor_name} (${investorProfile(comment.investor_type, comment.jurisdiction)})\nDEAL POINT TOPIC: ${comment.provision_topic}\n\nCOMMENT:\n"${comment.text}"\n\n${block('CURRENT DRAFT PROVISION', draftRows)}\n\n${block(
      'MODEL LANGUAGE',
      modelHits.map((h) => ({ id: h.id, heading: h.heading, text: h.text })),
    )}\n\n${block(`PRECEDENT — ${comment.investor_name} PRIOR SIDE LETTERS`, precedentRows)}\n\n${precedentPromptBlock(housePrecedent)}`,
    schema: suggestionSchema,
    maxTokens: 4_000,
  });

  markPrecedentsUsed(db, housePrecedent.map((h) => h.id));

  db.prepare(
    `UPDATE comments SET status = 'suggested', suggested_resolution = ?, suggestion_citations_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(
    `${result.data.dealPoint}: ${result.data.recommendedResolution}\n\nDraft response: ${result.data.draftResponseText}`,
    JSON.stringify(result.data.citations),
    commentId,
  );

  return { ...result.data, commentId, citationsVerified: result.citations };
}

/** Human judgment — a db write, no model call. The decision itself becomes
 *  precedent: what a lawyer stood behind is how the firm resolves this
 *  ground next time. Edited language weighs more than merely-accepted. */
export async function resolveComment(commentId: string, action: 'accept' | 'edit', text?: string): Promise<void> {
  const db = getDb();
  const comment = db
    .prepare(
      `SELECT c.suggested_resolution, c.provision_topic, c.fund_id, c.text AS comment_text, i.name AS investor_name, i.type AS investor_type
       FROM comments c JOIN investors i ON i.id = c.investor_id WHERE c.id = ?`,
    )
    .get(commentId) as
    | {
        suggested_resolution: string | null;
        provision_topic: string;
        fund_id: string;
        comment_text: string;
        investor_name: string;
        investor_type: string;
      }
    | undefined;
  if (!comment) throw new Error(`Unknown comment: ${commentId}`);
  const resolution = action === 'accept' ? comment.suggested_resolution : text;
  if (!resolution) throw new Error(action === 'accept' ? 'Nothing to accept — no suggestion yet' : 'Edited resolution text required');
  db.prepare(
    `UPDATE comments SET status = 'resolved', resolution_text = ?, resolved_by = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(resolution, action === 'accept' ? 'lawyer_accepted' : 'lawyer_edited', commentId);

  await promotePrecedent(db, {
    kind: 'resolution',
    topic: comment.provision_topic,
    title: `${comment.provision_topic.replace(/_/g, ' ')} resolution — ${comment.investor_type.replace(/_/g, ' ')} comment`,
    text: resolution,
    sourceType: 'comment',
    sourceId: commentId,
    fundId: comment.fund_id,
    weight: action === 'edit' ? 1.3 : 1.0,
  });
}

// ── Ingestion — comments enter through the front door ───────────────────

const atomizeSchema = z.object({
  comments: z.array(
    z.object({
      provisionTopic: z
        .string()
        .describe(
          'One of: geographic, mfn, co_invest, fees, distributions, reporting, key_person, transfer, excuse, advisory_board, confidentiality, capital_calls, indemnification, other',
        ),
      text: z.string().describe("The investor's point, restated faithfully as one self-contained comment"),
    }),
  ),
});

export interface IngestedComments {
  count: number;
  topics: string[];
}

/**
 * Paste LP counsel's mark-up / email / comment memo; it is atomized into
 * individual deal-point comments and entered into the triage queue — so the
 * negotiation stage runs on what investors actually sent, not seed rows.
 */
export async function ingestComments(opts: {
  fundId: string;
  investorId: string;
  text: string;
}): Promise<IngestedComments> {
  const db = getDb();
  const investor = db.prepare(`SELECT id, name FROM investors WHERE id = ?`).get(opts.investorId) as
    | { id: string; name: string }
    | undefined;
  const fund = db.prepare(`SELECT id FROM funds WHERE id = ?`).get(opts.fundId) as { id: string } | undefined;
  if (!investor || !fund) throw new Error('Unknown investor or fund');
  if (!opts.text?.trim() || opts.text.trim().length < 20) throw new Error('Paste the mark-up or comment text first.');

  const result = await callStructured({
    stage: 'comments.ingest',
    scopeFundId: opts.fundId,
    // the comments aren't inserted yet, so the scoped term query can't see
    // this investor — name it explicitly
    protectNames: [investor.name],
    system:
      "Atomize investor counsel's mark-up into individual deal-point comments for a fund negotiation tracker. One entry per distinct point; keep the substance faithful (do not soften or editorialize); classify each to its deal-point topic. Skip pleasantries and process emails.",
    user: opts.text,
    schema: atomizeSchema,
    maxTokens: 6_000,
    effort: 'medium',
  });

  const insert = db.prepare(
    `INSERT INTO comments (id, fund_id, investor_id, provision_topic, text, status) VALUES (?, ?, ?, ?, ?, 'open')`,
  );
  const topics = new Set<string>();
  db.transaction(() => {
    for (const c of result.data.comments) {
      insert.run(genId('c'), opts.fundId, investor.id, c.provisionTopic, c.text);
      topics.add(c.provisionTopic);
    }
  })();

  return { count: result.data.comments.length, topics: [...topics] };
}
