/**
 * Comment triage — investor comments organized by deal point, with AI
 * suggested resolutions citing model language and precedent. The lawyer's
 * judgment stays in the loop: accepting or editing a resolution is a pure
 * database write, never a model call.
 */

import { z } from 'zod';
import { getDb } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';

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

  const result = await callStructured({
    stage: 'comments.suggest',
    system: `You are a fund formation partner resolving an investor comment on a draft LPA. Recommend a resolution grounded in the firm's model language and this investor's own precedent. Citation quotes must be copied verbatim from the provided sources. Be commercial: protect the sponsor while keeping the investor in the fund.`,
    user: `INVESTOR: ${comment.investor_name} (${comment.investor_type}, ${comment.jurisdiction})\nDEAL POINT TOPIC: ${comment.provision_topic}\n\nCOMMENT:\n"${comment.text}"\n\n${block('CURRENT DRAFT PROVISION', draftRows)}\n\n${block(
      'MODEL LANGUAGE',
      modelHits.map((h) => ({ id: h.id, heading: h.heading, text: h.text })),
    )}\n\n${block(`PRECEDENT — ${comment.investor_name} PRIOR SIDE LETTERS`, precedentRows)}`,
    schema: suggestionSchema,
    maxTokens: 4_000,
  });

  db.prepare(
    `UPDATE comments SET status = 'suggested', suggested_resolution = ?, suggestion_citations_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(
    `${result.data.dealPoint}: ${result.data.recommendedResolution}\n\nDraft response: ${result.data.draftResponseText}`,
    JSON.stringify(result.data.citations),
    commentId,
  );

  return { ...result.data, commentId, citationsVerified: result.citations };
}

/** Human judgment — pure db write, no model call. */
export function resolveComment(commentId: string, action: 'accept' | 'edit', text?: string): void {
  const db = getDb();
  const comment = db.prepare(`SELECT suggested_resolution FROM comments WHERE id = ?`).get(commentId) as
    | { suggested_resolution: string | null }
    | undefined;
  if (!comment) throw new Error(`Unknown comment: ${commentId}`);
  const resolution = action === 'accept' ? comment.suggested_resolution : text;
  if (!resolution) throw new Error(action === 'accept' ? 'Nothing to accept — no suggestion yet' : 'Edited resolution text required');
  db.prepare(
    `UPDATE comments SET status = 'resolved', resolution_text = ?, resolved_by = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(resolution, action === 'accept' ? 'lawyer_accepted' : 'lawyer_edited', commentId);
}
