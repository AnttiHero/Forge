import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, setDb } from '../db/db.js';
import { resetHealthCache } from './ollama.js';
import { sanitizeOutbound, restoreInbound, resetGateway } from './gateway.js';

function seedMinimal(db: ReturnType<typeof openDb>): void {
  db.prepare(
    `INSERT INTO funds (id, name, numeral, target_size_usd, strategy, status, vintage) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('fund-3', 'Vulcan Industrial Partners III', 3, 3_000_000_000, 'industrials', 'forming', 2026);
  db.prepare(`INSERT INTO investors (id, name, type, jurisdiction) VALUES (?, ?, ?, ?)`).run(
    'inv-1',
    'Norrland Pension AB',
    'pension',
    'Sweden',
  );
}

describe('privacy gateway', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gw-'));
    const db = openDb(path.join(dir, 'test.db'));
    seedMinimal(db);
    setDb(db);
    resetGateway();
    resetHealthCache();
  });

  afterEach(() => {
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('degrades to regex-only when Ollama is down (nerUsed: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await sanitizeOutbound('Vulcan Industrial Partners III owes Norrland Pension AB $1,000,000.');
    expect(result.nerUsed).toBe(false);
    expect(result.sanitized).not.toContain('Vulcan');
    expect(result.sanitized).not.toContain('Norrland');
    expect(result.sanitized).toContain('[FUND_1]');
    expect(result.sanitized).toContain('[INVESTOR_1]');
  });

  it('uses NER assist but rejects hallucinated entities', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return new Response('{}', { status: 200 });
      if (u.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: [
                      { text: 'Ferrum Holdings GmbH', type: 'party' }, // present → accepted
                      { text: 'Acme Hallucinated Corp', type: 'party' }, // absent → rejected
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sanitizeOutbound('A side letter was granted to Ferrum Holdings GmbH last year.');
    expect(result.nerUsed).toBe(true);
    expect(result.sanitized).not.toContain('Ferrum Holdings GmbH');
    expect(result.sanitized).toContain('[PARTY_1]');
    expect(result.mappings.some((m) => m.original === 'Acme Hallucinated Corp')).toBe(false);
  });

  it('never re-masks placeholder innards returned by NER (no nested mappings)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return new Response('{}', { status: 200 });
      // local model "finds" the innards of an existing placeholder
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ entities: [{ text: 'INVESTOR_1', type: 'party' }, { text: 'FUND_1', type: 'party' }] }) } },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sanitizeOutbound('Norrland Pension AB invests in Vulcan Industrial Partners III.');
    expect(result.sanitized).not.toContain('[[');
    expect(result.mappings.every((m) => !/^[A-Z]+_\d+$/.test(m.original))).toBe(true);
    // restore roundtrip stays clean
    const restored = restoreInbound(result.sanitized, result.mappings);
    expect(restored).toContain('Norrland Pension AB');
    expect(restored).not.toContain('[INVESTOR');
  });

  it('keeps mappings sticky across calls in the same run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const a = await sanitizeOutbound('Norrland Pension AB asks for MFN.', 'run-1');
    const b = await sanitizeOutbound('Re: Norrland Pension AB request.', 'run-1');
    expect(a.sanitized).toContain('[INVESTOR_1]');
    expect(b.sanitized).toContain('[INVESTOR_1]');
  });

  it('restoreInbound deep-walks nested structures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const { mappings } = await sanitizeOutbound('Vulcan Industrial Partners III.');
    const restored = restoreInbound(
      { answer: 'Per [FUND_1] LPA', citations: [{ quote: '[FUND_1] shall notify' }] },
      mappings,
    );
    expect(restored.answer).toBe('Per Vulcan Industrial Partners III LPA');
    expect(restored.citations[0].quote).toBe('Vulcan Industrial Partners III shall notify');
  });

  it('survives garbage JSON from the local model', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sanitizeOutbound('Vulcan Industrial Partners III update.');
    expect(result.nerUsed).toBe(false);
    expect(result.sanitized).toContain('[FUND_1]');
  });
});
