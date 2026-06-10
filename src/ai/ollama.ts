/**
 * Ollama client — the local model every lawyer has on their machine.
 *
 * Two jobs: JSON chat (NER assist for the privacy gateway) and embeddings
 * (local semantic search). Plain HTTP against Ollama's OpenAI-compatible
 * endpoint; no SDK. Everything degrades gracefully when Ollama is down.
 */

import { config } from '../config.js';

let healthCache: { up: boolean; checkedAt: number } | null = null;
const HEALTH_TTL_MS = 30_000;

/** Cached health probe — true when Ollama responds within 2s. */
export async function isUp(): Promise<boolean> {
  const now = Date.now();
  if (healthCache && now - healthCache.checkedAt < HEALTH_TTL_MS) return healthCache.up;
  let up = false;
  try {
    const res = await fetch(`${config.ollama.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    up = res.ok;
  } catch {
    up = false;
  }
  healthCache = { up, checkedAt: now };
  return up;
}

/** Reset the health cache (tests). */
export function resetHealthCache(): void {
  healthCache = null;
}

/**
 * Single-turn JSON chat against the local model. Throws on any failure —
 * callers decide how to degrade.
 */
export async function chatJson(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 1_000,
): Promise<unknown> {
  const res = await fetch(`${config.ollama.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(config.ollama.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Local model returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Local model returned empty response');
  return safeJsonParse(content);
}

/** Embed a batch of texts via Ollama's /api/embed. Throws on failure. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${config.ollama.baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollama.embedModel, input: texts }),
    signal: AbortSignal.timeout(config.ollama.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Embedding model returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error('Embedding model returned unexpected shape');
  }
  return data.embeddings;
}

/** Parse model output that may be fenced or wrapped in prose. */
export function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    /* try fallbacks */
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* try last fallback */
    }
  }
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]);
    } catch {
      /* fall through */
    }
  }
  throw new Error('Local model returned malformed JSON');
}
