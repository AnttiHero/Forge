import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDb, setDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { verifyCitation, verifyCitationsDeep } from './citations.js';
import { callStructured, setAnthropicClient } from '../ai/claude.js';
import { resetGateway } from '../ai/gateway.js';
import { resetHealthCache } from '../ai/ollama.js';
import { citationSchema } from './citations.js';

describe('citation verifier', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cite-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('verifies an exact quote from a provision', () => {
    expect(
      verifyCitation(db, {
        sourceType: 'provision',
        sourceId: 'p-sl-norr-1',
        quote: 'Norrland Pension AB shall be excused from participation',
      }),
    ).toBe(true);
  });

  it('verifies whitespace-normalized quotes', () => {
    expect(
      verifyCitation(db, {
        sourceType: 'provision',
        sourceId: 'p-sl-norr-1',
        quote: 'Norrland   Pension AB\n shall be   excused from participation',
      }),
    ).toBe(true);
  });

  it('verifies through masked name slots (placeholder vs restored name)', () => {
    // Source has a real name; quote carries a (renumbered) placeholder in the
    // same slot. The legal language matches, so it should verify.
    const mappings = [{ placeholder: '[INVESTOR_3]', original: 'Meridian State Pension', type: 'investor' as const }];
    // p-sl-norr-1 text mentions "Norrland Pension AB shall be excused from participation"
    expect(
      verifyCitation(
        db,
        { sourceType: 'provision', sourceId: 'p-sl-norr-1', quote: '[INVESTOR_3] shall be excused from participation' },
        [{ placeholder: '[INVESTOR_3]', original: 'Norrland Pension AB', type: 'investor' as const }],
      ),
    ).toBe(true);
    // unrelated mapping shouldn't make a fabricated quote pass
    expect(
      verifyCitation(db, { sourceType: 'provision', sourceId: 'p-sl-norr-1', quote: '[INVESTOR_3] shall buy a yacht' }, mappings),
    ).toBe(false);
  });

  it('rejects fabricated quotes and unknown sources', () => {
    expect(
      verifyCitation(db, { sourceType: 'provision', sourceId: 'p-sl-norr-1', quote: 'The Fund shall buy a yacht' }),
    ).toBe(false);
    expect(verifyCitation(db, { sourceType: 'provision', sourceId: 'nope', quote: 'anything' })).toBe(false);
    expect(verifyCitation(db, { sourceType: 'provision', sourceId: 'p-sl-norr-1', quote: '' })).toBe(false);
  });

  it('deep-walks nested results and marks verified in place', () => {
    const value = {
      answer: 'x',
      items: [
        {
          citations: [
            { sourceType: 'obligation', sourceId: 'obl-01', quote: 'Norrland Pension AB shall be excused' },
            { sourceType: 'obligation', sourceId: 'obl-01', quote: 'fabricated text' },
          ],
        },
      ],
    };
    const tally = verifyCitationsDeep(db, value);
    expect(tally).toEqual({ total: 2, verified: 1 });
    expect((value.items[0].citations[0] as { verified?: boolean }).verified).toBe(true);
    expect((value.items[0].citations[1] as { verified?: boolean }).verified).toBe(false);
  });
});

describe('callStructured (mocked client)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-call-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    setDb(db);
    resetGateway();
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ollama down')));
  });

  afterEach(() => {
    setAnthropicClient(null);
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('sanitizes outbound, restores inbound, verifies citations, audits', async () => {
    let promptSeen = '';
    setAnthropicClient({
      messages: {
        parse: async (req: { messages: Array<{ content: string }> }) => {
          promptSeen = req.messages[0].content;
          return {
            parsed_output: {
              answer: 'Per [INVESTOR_1] side letter, excusal applies.',
              citations: [
                {
                  sourceType: 'obligation',
                  sourceId: 'obl-01',
                  quote: '[INVESTOR_1] shall be excused from participation',
                },
              ],
            },
            usage: { input_tokens: 100, output_tokens: 50 },
            stop_reason: 'end_turn',
          };
        },
      },
    });

    const schema = z.object({ answer: z.string(), citations: z.array(citationSchema) });
    const result = await callStructured({
      stage: 'test.stage',
      system: 'You are a test.',
      user: 'What did Norrland Pension AB negotiate?',
      schema,
    });

    // Outbound was sanitized
    expect(promptSeen).not.toContain('Norrland');
    expect(promptSeen).toContain('[INVESTOR_1]');
    // Inbound was restored, including inside citation quotes
    expect(result.data.answer).toContain('Norrland Pension AB');
    // Citation verified after de-anonymization
    expect(result.citations).toEqual({ total: 1, verified: 1 });

    const audit = db.prepare(`SELECT * FROM ai_calls WHERE id = ?`).get(result.auditId) as {
      stage: string;
      sanitized_prompt: string;
      ok: number;
    };
    expect(audit.stage).toBe('test.stage');
    expect(audit.sanitized_prompt).not.toContain('Norrland');
    expect(audit.ok).toBe(1);
  });

  it('writes a failed audit row and rethrows on API error', async () => {
    setAnthropicClient({
      messages: {
        parse: async () => {
          throw new Error('boom');
        },
      },
    });
    const schema = z.object({ answer: z.string() });
    await expect(
      callStructured({ stage: 'test.fail', system: 's', user: 'u', schema }),
    ).rejects.toThrow('boom');
    const row = db.prepare(`SELECT ok FROM ai_calls WHERE stage = 'test.fail'`).get() as { ok: number };
    expect(row.ok).toBe(0);
  });
});
