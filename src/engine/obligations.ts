/**
 * Obligations engine — the ontology payoff.
 *
 * extractObligations: closed document → structured obligation records,
 * every source clause verified verbatim before insert.
 *
 * answerObligationQuery: "time-sensitive deal in sub-Saharan Africa — what
 * obligations do we have?" → filters (tiny call) → local retrieval →
 * synthesized answer with checklist, affected investors, citations.
 */

import { z } from 'zod';
import { getDb, genId } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { citationSchema, quoteAppearsIn } from './citations.js';
import { hybridSearch } from '../search/hybrid.js';
import { embedAll } from '../search/embeddings.js';

const OBLIGATION_TYPES = [
  'notice',
  'consent',
  'reporting',
  'excuse',
  'transfer_restriction',
  'mfn',
  'investment_restriction',
] as const;

// ── Extraction ───────────────────────────────────────────────────────────

const extractionSchema = z.object({
  obligations: z.array(
    z.object({
      type: z.enum(OBLIGATION_TYPES),
      investorName: z.string().nullable().describe('Investor the obligation is owed to, or null if owed to all LPs'),
      geography: z.string().nullable().describe('Geographic scope if any, e.g. "sub-Saharan Africa"'),
      noticeDays: z.number().nullable().describe('Day count for any notice/reporting deadline'),
      summary: z.string().describe('One-sentence plain-language summary'),
      sourceClause: z.string().describe('VERBATIM quote of the clause creating the obligation — copy exactly'),
    }),
  ),
});

export interface ExtractedObligation {
  id: string;
  type: string;
  investorId: string | null;
  geography: string | null;
  noticeDays: number | null;
  summary: string;
  sourceClause: string;
  verified: boolean;
}

export async function extractObligations(documentId: string): Promise<{ obligations: ExtractedObligation[]; auditId: string }> {
  const db = getDb();
  const doc = db.prepare(`SELECT id, fund_id, title, content FROM documents WHERE id = ?`).get(documentId) as
    | { id: string; fund_id: string | null; title: string; content: string }
    | undefined;
  if (!doc) throw new Error(`Unknown document: ${documentId}`);
  if (!doc.fund_id) throw new Error(`Document ${documentId} is not attached to a fund`);

  const result = await callStructured({
    stage: 'obligations.extract',
    scopeFundId: doc.fund_id,
    system: `You are the obligations desk of a fund formation practice. Extract every ongoing obligation of the General Partner / the Fund from the document: notices, consents, reporting duties, excusal rights, transfer restrictions, MFN rights, investment restrictions. Rules: (1) sourceClause must be copied VERBATIM from the document — never paraphrase inside sourceClause; (2) one record per distinct obligation; (3) investorName only when the obligation is owed to a specific named investor.`,
    user: `DOCUMENT (${doc.title}):\n\n${doc.content}`,
    schema: extractionSchema,
    maxTokens: 8_000,
  });

  const investors = db.prepare(`SELECT id, name FROM investors`).all() as Array<{ id: string; name: string }>;

  const insert = db.prepare(
    `INSERT INTO obligations (id, fund_id, investor_id, source_document_id, type, summary, geography, notice_days, source_clause, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const extracted: ExtractedObligation[] = [];
  for (const o of result.data.obligations) {
    const verified = quoteAppearsIn(doc.content, o.sourceClause, result.mappings);
    const investor = o.investorName
      ? investors.find((i) => i.name.toLowerCase() === o.investorName!.toLowerCase()) ?? null
      : null;
    const id = genId('obl');
    insert.run(
      id,
      doc.fund_id,
      investor?.id ?? null,
      doc.id,
      o.type,
      o.summary,
      o.geography ?? null,
      o.noticeDays ?? null,
      o.sourceClause,
      verified ? 1 : 0,
    );
    extracted.push({
      id,
      type: o.type,
      investorId: investor?.id ?? null,
      geography: o.geography,
      noticeDays: o.noticeDays,
      summary: o.summary,
      sourceClause: o.sourceClause,
      verified,
    });
  }

  // Index the new rows for semantic search (no-op when Ollama is down)
  await embedAll(
    db,
    extracted.map((o) => ({ ownerType: 'obligation' as const, ownerId: o.id, text: `${o.summary}\n${o.sourceClause}` })),
  );

  return { obligations: extracted, auditId: result.auditId };
}

// ── Natural-language Q&A ─────────────────────────────────────────────────

const filterSchema = z.object({
  types: z.array(z.enum(OBLIGATION_TYPES)).describe('Obligation types relevant to the question; empty for all'),
  geography: z.string().nullable().describe('Geographic scope mentioned or implied, else null'),
  keywords: z.string().describe('Search keywords for retrieval'),
});

const answerSchema = z.object({
  answer: z.string().describe('Direct answer to the question, 2-5 sentences'),
  checklist: z.array(
    z.object({
      step: z.string(),
      dueWithin: z.string().nullable().describe('Deadline, e.g. "15 Business Days before closing", else null'),
      citation: citationSchema,
    }),
  ),
  affectedInvestors: z.array(z.string()).describe('Names of investors whose rights are engaged'),
  citations: z.array(citationSchema),
});

export type ObligationAnswer = z.infer<typeof answerSchema> & {
  retrievedObligationIds: string[];
  citationsVerified: { total: number; verified: number };
};

export async function answerObligationQuery(question: string, fundId?: string): Promise<ObligationAnswer> {
  const db = getDb();
  const runId = genId('run');

  // Step 1: derive structured filters (small call)
  const filters = await callStructured({
    stage: 'obligations.filters',
    system:
      'Turn the question into retrieval filters for an obligations register of private fund commitments. Only output filters.',
    user: question,
    schema: filterSchema,
    maxTokens: 1_000,
    effort: 'medium',
    runId,
  });

  // Step 2: local retrieval — SQL filter ∪ hybrid search
  const params: unknown[] = [];
  const where: string[] = [];
  if (fundId) {
    where.push('o.fund_id = ?');
    params.push(fundId);
  }
  if (filters.data.types.length > 0) {
    where.push(`o.type IN (${filters.data.types.map(() => '?').join(',')})`);
    params.push(...filters.data.types);
  }
  if (filters.data.geography) {
    where.push(`(o.geography IS NOT NULL AND (LOWER(o.geography) LIKE ? OR LOWER(?) LIKE '%' || LOWER(o.geography) || '%'))`);
    params.push(`%${filters.data.geography.toLowerCase()}%`, filters.data.geography);
  }
  const sqlRows =
    where.length > 0
      ? (db.prepare(`SELECT o.id FROM obligations o WHERE ${where.join(' AND ')}`).all(...params) as Array<{ id: string }>)
      : [];

  const hits = await hybridSearch(db, {
    query: filters.data.keywords || question,
    table: 'obligations',
    fundId,
    topK: 8,
  });

  const ids = [...new Set([...sqlRows.map((r) => r.id), ...hits.map((h) => h.id)])].slice(0, 14);
  if (ids.length === 0) {
    return {
      answer: 'No obligations in the register match this question.',
      checklist: [],
      affectedInvestors: [],
      citations: [],
      retrievedObligationIds: [],
      citationsVerified: { total: 0, verified: 0 },
    };
  }

  const records = db
    .prepare(
      `SELECT o.id, o.type, o.summary, o.geography, o.notice_days, o.deadline, o.source_clause,
              f.name AS fund_name, i.name AS investor_name, d.title AS document_title
       FROM obligations o
       JOIN funds f ON f.id = o.fund_id
       LEFT JOIN investors i ON i.id = o.investor_id
       JOIN documents d ON d.id = o.source_document_id
       WHERE o.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const recordsBlock = records
    .map(
      (r) =>
        `[sourceType: obligation, sourceId: ${r.id}]\nfund: ${r.fund_name}\ninvestor: ${r.investor_name ?? 'all LPs'}\ntype: ${r.type}\ngeography: ${r.geography ?? '—'}\nnotice_days: ${r.notice_days ?? '—'}\nsummary: ${r.summary}\nsource document: ${r.document_title}\nsource clause: "${r.source_clause}"`,
    )
    .join('\n\n');

  // Step 3: synthesize from retrieved records only
  const result = await callStructured({
    stage: 'obligations.qa',
    system: `You are the obligations desk. Answer the question using ONLY the obligation records provided — never invent obligations. Every checklist step and citation must reference a provided record by its sourceId, and each citation quote must be copied verbatim from that record's source clause. Order the checklist by urgency (shortest deadline first).`,
    user: `QUESTION: ${question}\n\nOBLIGATION RECORDS:\n\n${recordsBlock}`,
    schema: answerSchema,
    maxTokens: 6_000,
    runId,
  });

  return {
    ...result.data,
    retrievedObligationIds: ids,
    citationsVerified: result.citations,
  };
}
