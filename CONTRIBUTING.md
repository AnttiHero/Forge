# Contributing to Forge

Thanks for jumping in. Forge is a local-first fund formation engine — a
frontier model for reasoning, a local model on your own machine for anything
confidential. Two principles are load-bearing; keep them intact:

1. **Nothing confidential leaves the machine un-masked.** Every frontier call
   goes through `src/ai/gateway.ts` → `src/ai/claude.ts`. Don't call the
   Anthropic SDK directly from a feature; route it through `callStructured`.
2. **Every AI assertion is quoted and verified.** Outputs carry citations
   that are checked verbatim against the source (`src/engine/citations.ts`).
   If you add a generative feature, give it a citation schema and let the
   verifier mark it.

## Getting started

Prerequisites: Node 20+, an `ANTHROPIC_API_KEY`, and (optional but
recommended) [Ollama](https://ollama.com) for on-device masking + search.

```bash
# 1. install (root API + web UI)
npm install
(cd web && npm install)

# 2. configure
cp .env.example .env          # add your ANTHROPIC_API_KEY

# 3. optional — the on-device model (privacy gateway + embeddings)
ollama pull gemma2:2b && ollama pull nomic-embed-text

# 4. load the demo corpus, then run
npm run seed
npm run dev                   # API + UI at http://localhost:3000
```

For hot-reloading UI work: `cd web && npm run dev` → http://localhost:5173
(it proxies `/api` to the server on :3000).

Forge degrades gracefully without Ollama — a badge shows "Degraded" and it
falls back to regex-only masking and keyword-only search — so you can develop
without it, but test the masking path with it running before shipping
privacy-related changes.

## Before you open a PR

```bash
npm test            # 48 unit tests, no network
npm run typecheck   # tsc on the API (the web UI is typechecked by its build)
npm run smoke       # end-to-end through every stage (needs ANTHROPIC_API_KEY;
                    # SMOKE_SKIP_DRAFTING=1 to skip the slow drafting stage)
```

- Keep the seed corpus (`seed/`) fictional — it's the public demo data.
- Match the surrounding style; no formatter config to fight.
- Changes to the privacy gateway or citation verifier should come with a
  test, and ideally a second reviewer — a silent regression there is the one
  failure mode that actually matters.

## Not legal advice

Forge is drafting and tracking support, not legal advice. Keep that framing in
any user-facing copy you add.
