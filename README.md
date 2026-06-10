# Forge — a fund formation engine

> "The idea is that we're going to take the collective intelligence of our
> institution and be able to deploy that throughout our firm."

A fun-but-real homage to the Kirkland & Ellis / Palantir "Fund Formation
Engine", built local-first: a frontier model for the reasoning, a local model
on the lawyer's own machine for everything confidential.

Fictional client: **Vulcan Industrial Partners** (named for the Roman god of
the forge), raising Fund III — $3B, 14 investors. Not legal advice; not a
law firm; not affiliated with anyone.

## What it does

**Bring your own documents.** The *Intake* tab is the point of it: create an
engagement, upload your own LPA or side letter (PDF / Word / Markdown / text),
and the engine parses it on-device, extracts every ongoing obligation, and
checks each one verbatim against the source before it enters your register —
then you can ask the register in plain English. The fictional Vulcan corpus
below is just a worked example; the tool runs on real documents.

The full demo arc, each stage thin but real:

1. **Drafting** — paste a commercial term sheet; four specialized roles
   (insight-capturer → extractor → drafter → feedback-integrator) draft LPA
   sections from the model-document library, prior funds, and what investors
   said last time. Progress streams live.
2. **Change assessment** — "expand the geographic mandate to emerging
   markets" → current reading, market examples from the corpus, a menu of
   drafting alternatives.
3. **Comment triage** — investor comments organized by deal point, AI
   suggested resolutions citing model language and the investor's own
   precedent. Accepting or editing is a pure database write — the lawyer's
   judgment never leaves the loop.
4. **Side letters** — agreed terms in, **three** complete drafts out,
   following the reuse hierarchy: exact model language → adapted precedent →
   fresh drafting. Every clause is color-coded by where its words came from.
5. **Obligations register** — the ontology payoff. "We have a time-sensitive
   new deal in sub-Saharan Africa — what obligations do we have?" → answer,
   urgency-ordered checklist, affected investors, every step citing the
   clause that created the duty, verified verbatim.
6. **MFN compendium** — every side-letter provision in the fund, the
   eligibility threshold and election window parsed from the fund's own MFN
   clause, who can elect what (grantee excluded), the election deadline, and
   an electable vs recipient-specific classification with cited reasoning.
7. **Word-native deliverables** — the MFN compendium and side-letter draft
   sets export as clean .docx with a numbered Sources annex: every in-text
   [n] marker resolves to the verbatim quoted clause, its ontology id, and
   its verification mark, so the trust story survives the export.
8. **Deadlines — obligations that act.** Concrete due dates computed for
   every recurring duty (quarterly/annual anchors, business-day math read
   from the clause itself), an event planner ("closing July 15 → notice to
   Norrland due June 24"), drafted reminder emails with verified citations,
   and one-click iCalendar export. The date math is deterministic and local
   — no model call; only the email drafting touches the frontier.

## The two models

- **Frontier**: `claude-fable-5` (Anthropic) does the drafting and reasoning —
  structured output only, every response schema-validated.
- **Local** (Ollama, on your machine) plays two roles:
  - **Privacy gateway** — before any text leaves the machine, fund and
    investor names (and derived short forms) are replaced with reversible
    placeholders using the ontology as the source of truth, then a local
    NER pass catches names the ontology has never seen. The frontier model
    sees `[INVESTOR_3]`; your client list stays home.
  - **Local search** — embeddings + SQLite FTS5 hybrid retrieval. Retrieval
    always runs locally on raw data.

The **"What left your machine"** panel shows the exact sanitized payload of
every frontier call. When Ollama is down, everything degrades gracefully:
regex-only anonymization, keyword-only search, a visible badge.

**Citations are enforced, not requested.** Every AI assertion must quote its
source; quotes are verified verbatim (whitespace-normalized) against the
ontology after de-anonymization. Unverified citations are flagged in the UI.

## Run it

```bash
npm install && (cd web && npm install)

cp .env.example .env          # add your ANTHROPIC_API_KEY

# optional but recommended — the local model
ollama pull gemma2:2b && ollama pull nomic-embed-text

npm run seed                  # load the Vulcan corpus (+ embeddings if Ollama is up)
(cd web && npm run build)     # build the UI once
npm run dev                   # http://localhost:3000
```

Dev UI with hot reload: `cd web && npm run dev` → http://localhost:5173.

## Verify

```bash
npm test          # unit tests — no network
npm run smoke     # end-to-end through all five stages + degraded pass
                  # (needs ANTHROPIC_API_KEY; SMOKE_SKIP_DRAFTING=1 to skip the slow stage)
```

## Layout

```
src/
  config.ts            env-backed configuration
  documents/parser.ts  parse uploaded PDF/DOCX/MD/TXT → citable provisions
  engine/intake.ts     create an engagement + ingest your own documents
  db/                  SQLite ontology: funds → investors → documents →
                       provisions → comments → side_letters → obligations,
                       ai_calls audit, embeddings; FTS5 + sync triggers
  privacy/anonymize.ts reversible placeholder anonymizer (regex, local)
  ai/ollama.ts         local model client (NER chat + embeddings + health)
  ai/gateway.ts        the privacy gateway — nothing leaves unsanitized
  ai/claude.ts         the ONE place Fable 5 is called: sanitize → call →
                       de-anonymize → verify citations → audit
  search/              hybrid retrieval (BM25 + cosine, degrades to BM25)
  engine/              the five stages + citation verifier + run progress
  api/routes.ts        REST + SSE
  seed/seed.ts         loads seed/ (the fictional Vulcan corpus)
web/                   React 19 + Vite + Tailwind 4 dashboard
scripts/smoke.ts       end-to-end smoke test
```
