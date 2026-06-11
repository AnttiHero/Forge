/**
 * End-to-end tests for the frontier paths the unit suite used to skip —
 * extractObligations and answerObligationQuery — with a mocked Anthropic
 * client. No network: what's under test is everything around the model
 * call (masking of every outbound prompt, restore, citation verification,
 * fuzzy attribution, DB writes, disclosure counts, registry lifecycle).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, setDb } from '../db/db.js';
import { seedDatabase } from '../seed/seed.js';
import { extractObligations, answerObligationQuery } from './obligations.js';
import { ingestComments } from './comments.js';
import { askHelper } from './helper.js';
import { setAnthropicClient } from '../ai/claude.js';
import { resetGateway, activeRunCount } from '../ai/gateway.js';
import { resetHealthCache } from '../ai/ollama.js';

interface FakeRequest {
  system: string;
  messages: Array<{ content: string }>;
}

/** Routes by system-prompt content; records every request it sees. */
function installFakeClient(handlers: Array<{ match: RegExp; output: (req: FakeRequest) => unknown }>): FakeRequest[] {
  const seen: FakeRequest[] = [];
  setAnthropicClient({
    messages: {
      parse: async (req: FakeRequest) => {
        seen.push(req);
        const h = handlers.find((h) => h.match.test(req.system));
        if (!h) throw new Error(`fake client: no handler for system prompt: ${req.system.slice(0, 80)}`);
        return {
          parsed_output: h.output(req),
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 100 },
        };
      },
    },
  });
  return seen;
}

describe('frontier paths, end to end with a mocked client', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-frontier-'));
    db = openDb(path.join(dir, 'test.db'));
    await seedDatabase(db, { embeddings: false });
    setDb(db);
    resetGateway();
    resetHealthCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ollama down'))); // regex-only masking — worst case
  });

  afterEach(() => {
    setAnthropicClient(null);
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('extractObligations: masks the prompt, verifies verbatim clauses, attributes fuzzily, persists', async () => {
    const doc = db.prepare(`SELECT content FROM documents WHERE id = 'doc-sl-norrland'`).get() as { content: string };
    // a real sentence straight out of the document, and a fabricated one
    const verbatim = doc.content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 80)!;

    const seen = installFakeClient([
      {
        match: /obligations desk of a fund formation practice/,
        output: () => ({
          obligations: [
            {
              type: 'reporting',
              investorName: 'Norrland Pension', // short form — fuzzy attribution must resolve it
              geography: null,
              noticeDays: 120,
              summary: 'Annual ESG report.',
              sourceClause: verbatim,
            },
            {
              type: 'notice',
              investorName: null,
              geography: null,
              noticeDays: 15,
              summary: 'Invented duty that appears nowhere in the document.',
              sourceClause: 'The General Partner shall sacrifice a goat at each closing.',
            },
          ],
        }),
      },
    ]);

    const before = (db.prepare(`SELECT COUNT(*) AS n FROM obligations`).get() as { n: number }).n;
    const { obligations } = await extractObligations('doc-sl-norrland');

    // every outbound prompt — system AND user — must be name-free
    for (const req of seen) {
      const outbound = `${req.system}\n${req.messages[0].content}`;
      expect(outbound).not.toContain('Norrland');
      expect(outbound).not.toContain('Vulcan');
    }

    expect(obligations).toHaveLength(2);
    const real = obligations.find((o) => o.summary === 'Annual ESG report.')!;
    expect(real.verified).toBe(true);
    expect(real.investorId).toBe('inv-norrland'); // "Norrland Pension" → fuzzy match
    const fake = obligations.find((o) => /goat/.test(o.sourceClause))!;
    expect(fake.verified).toBe(false); // fabricated clause must NOT verify

    const after = (db.prepare(`SELECT COUNT(*) AS n FROM obligations`).get() as { n: number }).n;
    expect(after).toBe(before + 2); // both persisted, verification flag tells them apart
  });

  it('answerObligationQuery: masked prompts, verified citations, honest disclosure, no registry leak', async () => {
    const norrlandClause = (
      db.prepare(`SELECT source_clause FROM obligations WHERE id = 'obl-01'`).get() as { source_clause: string }
    ).source_clause;

    const seen = installFakeClient([
      {
        match: /retrieval filters/,
        output: () => ({ types: ['excuse'], geography: 'sub-Saharan Africa', keywords: 'excused investments Africa' }),
      },
      {
        match: /obligations desk\. Answer the question/,
        output: () => ({
          answer: 'Norrland Pension AB holds an excusal right for these jurisdictions.',
          checklist: [
            {
              step: 'Check the excusal election before closing.',
              dueWithin: null,
              citation: { sourceType: 'obligation', sourceId: 'obl-01', quote: norrlandClause.slice(0, 120) },
            },
          ],
          affectedInvestors: ['Norrland Pension AB'],
          citations: [{ sourceType: 'obligation', sourceId: 'obl-01', quote: norrlandClause.slice(0, 120) }],
        }),
      },
    ]);

    const result = await answerObligationQuery('What about a deal in sub-Saharan Africa?');

    expect(seen.length).toBe(2); // filters + synthesis
    for (const req of seen) {
      const outbound = `${req.system}\n${req.messages[0].content}`;
      expect(outbound).not.toContain('Norrland');
      expect(outbound).not.toContain('Khalij');
      expect(outbound).not.toContain('Hokuriku');
    }

    // disclosure is real numbers, not decoration
    expect(result.consideredCount).toBeGreaterThan(0);
    expect(result.consideredCount).toBeLessThanOrEqual(14);
    expect(result.totalOnFile).toBeGreaterThanOrEqual(result.consideredCount);
    expect(result.retrievedObligationIds).toContain('obl-01');
    // verbatim citation against the register verified
    expect(result.citationsVerified.verified).toBeGreaterThan(0);

    // the per-run mapping registry must not outlive the request
    expect(activeRunCount()).toBe(0);
  });

  it('Cassie: masked snapshot, valid tab routing, live numbers from the file', async () => {
    const seen = installFakeClient([
      {
        match: /You are Cassie/,
        output: () => ({
          answer: 'Upload it under Documents and every duty in it will be checked word-for-word.',
          suggestedTab: 'intake',
          followUps: ['How do I link it to an investor?'],
        }),
      },
    ]);

    const reply = await askHelper({ question: 'Where do I add my own contract?' });

    // her prompt carries the live practice snapshot, so it MUST be masked
    expect(seen.length).toBe(1);
    const outbound = `${seen[0].system}\n${seen[0].messages[0].content}`;
    expect(outbound).not.toContain('Norrland');
    expect(outbound).not.toContain('Hokuriku');
    expect(outbound).toContain('PRACTICE SNAPSHOT'); // the live numbers really went along
    expect(outbound).toMatch(/obligations on the register: \d+/);

    expect(reply.suggestedTab).toBe('intake');
    expect(reply.suggestedTabLabel).toBe('Documents');
    expect(reply.followUps).toHaveLength(1);
  });

  it('re-ingesting the same mark-up does not duplicate the triage queue', async () => {
    installFakeClient([
      {
        match: /Atomize investor counsel/,
        output: () => ({
          comments: [
            { provisionTopic: 'fees', text: 'The management fee should step down to 1.25% after the investment period.' },
            { provisionTopic: 'reporting', text: 'Quarterly ILPA-format statements within 45 days.' },
          ],
        }),
      },
    ]);

    const first = await ingestComments({
      fundId: 'fund-3',
      investorId: 'inv-norrland',
      text: 'Dear counsel, we require a fee step-down and quarterly ILPA reporting. Regards.',
    });
    expect(first.count).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const second = await ingestComments({
      fundId: 'fund-3',
      investorId: 'inv-norrland',
      text: 'Dear counsel, we require a fee step-down and quarterly ILPA reporting. Regards.',
    });
    expect(second.count).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM comments WHERE investor_id = 'inv-norrland' AND fund_id = 'fund-3' AND text LIKE '%1.25%'`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
