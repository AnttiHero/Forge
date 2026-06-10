/**
 * The ONE place Fable 5 is called. Every engine module goes through
 * callStructured(), so the privacy gateway, citation verification and the
 * audit log are unskippable.
 *
 * Sequence: sanitize → claude-fable-5 (structured output) → de-anonymize →
 * verify citations → write ai_calls audit row.
 *
 * Fable 5 rules baked in here: no temperature/top_p/top_k, no `thinking`
 * param at all, structured output via messages.parse + output_config.format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../config.js';
import { getDb, genId } from '../db/db.js';
import { sanitizeOutbound, restoreInbound } from './gateway.js';
import { verifyCitationsDeep } from '../engine/citations.js';
import type { EntityMapping } from '../privacy/anonymize.js';

export interface CallOptions<T> {
  /** e.g. 'obligations.qa', 'drafting.extractor' — shown in the privacy panel */
  stage: string;
  /** Sticky anonymization context across a pipeline run */
  runId?: string;
  system: string;
  /** RAW text — sanitized inside; never pre-anonymize */
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Scope name-masking to one matter's fund + committed investors. Omit
   *  for cross-fund calls (e.g. the obligations register). */
  scopeFundId?: string;
}

export interface CallResult<T> {
  data: T;
  citations: { total: number; verified: number };
  /** Anonymization mappings for this call — engines can reuse them to
   *  verify their own verbatim fields against source documents. */
  mappings: EntityMapping[];
  nerUsed: boolean;
  auditId: string;
  durationMs: number;
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — Forge needs it for engine calls.');
  }
  _client = new Anthropic();
  return _client;
}

/** Inject a fake client (tests). Pass null to reset. */
export function setAnthropicClient(client: unknown): void {
  _client = client as Anthropic | null;
}

export async function callStructured<T>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const db = getDb();
  const started = Date.now();
  const auditId = genId('call');

  // 1. Nothing leaves the machine un-sanitized.
  const { sanitized, mappings, stats, nerUsed } = await sanitizeOutbound(opts.user, opts.runId, opts.scopeFundId);
  const system = `${opts.system}\n\nNote: bracketed tokens like [INVESTOR_1] in the input are protected references. Reproduce them exactly as written wherever you refer to that entity — never alter, renumber, or invent such tokens.`;
  const sanitizedPrompt = `SYSTEM:\n${system}\n\nUSER:\n${sanitized}`;

  const writeAudit = (ok: boolean, inputTokens: number, outputTokens: number): void => {
    db.prepare(
      `INSERT INTO ai_calls (id, stage, model, sanitized_prompt, entity_stats_json, ner_used, duration_ms, input_tokens, output_tokens, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      auditId,
      opts.stage,
      config.anthropic.model,
      sanitizedPrompt,
      JSON.stringify(stats),
      nerUsed ? 1 : 0,
      Date.now() - started,
      inputTokens,
      outputTokens,
      ok ? 1 : 0,
    );
  };

  try {
    // 2. Fable 5 sees only sanitized text.
    const response = await getClient().messages.parse({
      model: config.anthropic.model,
      max_tokens: opts.maxTokens ?? 8_000,
      system,
      messages: [{ role: 'user', content: sanitized }],
      output_config: {
        format: zodOutputFormat(opts.schema),
        effort: opts.effort ?? 'high',
      },
    });

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new Error(`Fable 5 returned unparseable output (stop_reason: ${response.stop_reason})`);
    }

    // 3. Restore originals locally.
    const restored = restoreInbound(parsed as T, mappings);

    // 4. Verify citations AFTER de-anonymization — masked name slots count
    //    as wildcards so a renumbered/partly-restored placeholder still
    //    verifies the underlying legal language.
    const citations = verifyCitationsDeep(db, restored, mappings);

    // 5. Audit what left the machine.
    writeAudit(true, response.usage.input_tokens, response.usage.output_tokens);

    return { data: restored, citations, mappings, nerUsed, auditId, durationMs: Date.now() - started };
  } catch (err) {
    writeAudit(false, 0, 0);
    throw err;
  }
}
