/**
 * Forge — centralized configuration. All settings env-var backed.
 */

function safeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: safeInt(process.env.FORGE_PORT, 3000),
  host: process.env.FORGE_HOST ?? '127.0.0.1',
  dbPath: process.env.FORGE_DB_PATH ?? './data/forge.db',

  anthropic: {
    /** Read live so an interactively-exported key is picked up. */
    get apiKey(): string {
      return process.env.ANTHROPIC_API_KEY ?? '';
    },
    model: process.env.FORGE_MODEL ?? 'claude-fable-5',
  },

  ollama: {
    baseUrl: (process.env.FORGE_OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
    model: process.env.FORGE_LOCAL_MODEL ?? 'gemma3:4b',
    embedModel: process.env.FORGE_EMBED_MODEL ?? 'nomic-embed-text',
    timeoutMs: safeInt(process.env.FORGE_OLLAMA_TIMEOUT_MS, 60_000),
  },
};
