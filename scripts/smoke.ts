/**
 * End-to-end smoke test — exercises all five engine stages against a
 * dedicated database, asserting schema-valid output with verified citations,
 * then re-runs a stage with Ollama unreachable to prove graceful degradation.
 *
 * Needs ANTHROPIC_API_KEY. Ollama optional (first pass uses it if present).
 * Skip the slowest stage with SMOKE_SKIP_DRAFTING=1.
 */

process.env.FORGE_DB_PATH = './data/smoke.db';

const { getDb } = await import('../src/db/db.js');
const { seedDatabase } = await import('../src/seed/seed.js');
const { answerObligationQuery } = await import('../src/engine/obligations.js');
const { suggestResolution, resolveComment } = await import('../src/engine/comments.js');
const { assessChange } = await import('../src/engine/changes.js');
const { generateSideLetterDrafts } = await import('../src/engine/side-letters.js');
const { startDraftingPipeline } = await import('../src/engine/drafting.js');
const { getRun } = await import('../src/engine/progress.js');
const { config } = await import('../src/config.js');
const { resetHealthCache, isUp } = await import('../src/ai/ollama.js');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function stage(name: string): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}`);
}

const db = getDb();

stage('Seed');
const summary = await seedDatabase(db);
check('corpus seeded', summary.funds === 3 && summary.obligations === 21);
check('all obligation citations verbatim', summary.unverifiedObligations.length === 0);
const ollamaUp = await isUp();
console.log(`  · Ollama: ${ollamaUp ? `up (${summary.embeddings} embeddings)` : 'down (keyword-only)'}`);

stage('Stage 5 — Obligations Q&A (the Africa question)');
const qa = await answerObligationQuery('We have a time-sensitive new deal in sub-Saharan Africa. What obligations do we have?');
check('answer produced', qa.answer.length > 50);
check('checklist non-empty', qa.checklist.length >= 3, `${qa.checklist.length} steps`);
check('citations verified', qa.citationsVerified.verified >= 1 && qa.citationsVerified.verified === qa.citationsVerified.total,
  `${qa.citationsVerified.verified}/${qa.citationsVerified.total}`);
check('Norrland excusal surfaced', qa.affectedInvestors.some((n) => n.includes('Norrland')));

stage('Stage 3 — Comment triage');
const suggestion = await suggestResolution('c-01');
check('resolution suggested', suggestion.recommendedResolution.length > 30);
check('suggestion cites sources', suggestion.citationsVerified.total >= 1,
  `${suggestion.citationsVerified.verified}/${suggestion.citationsVerified.total} verified`);
resolveComment('c-01', 'accept');
const resolved = db.prepare(`SELECT status, resolved_by FROM comments WHERE id = 'c-01'`).get() as { status: string; resolved_by: string };
check('lawyer accept is a pure db write', resolved.status === 'resolved' && resolved.resolved_by === 'lawyer_accepted');

stage('Stage 2 — Change assessment (emerging markets)');
const assessment = await assessChange('p-f3-geo', 'Expand the geographic mandate to include emerging markets.');
check('menu of alternatives', assessment.alternatives.length >= 3, `${assessment.alternatives.length} alternatives`);
check('market examples cited', assessment.marketExamples.length >= 1);
check('citations mostly verified', assessment.citationsVerified.verified >= 1,
  `${assessment.citationsVerified.verified}/${assessment.citationsVerified.total}`);

stage('Stage 4 — Side letters (three drafts)');
const drafts = await generateSideLetterDrafts({
  fundId: 'fund-3',
  investorId: 'inv-norrland',
  agreedTerms: [
    'Excusal from investments in EU-sanctioned or sub-investment-grade jurisdictions, including sub-Saharan Africa',
    'Annual ESG report on the Invest Europe template',
  ],
});
check('exactly three drafts', drafts.drafts.length === 3);
check('all three strategies present', new Set(drafts.drafts.map((d) => d.label)).size === 3);
check('every clause carries a tier', drafts.drafts.every((d) => d.clauses.every((c) => Boolean(c.tier))));
check('citations verified', drafts.citationsVerified.verified >= 1,
  `${drafts.citationsVerified.verified}/${drafts.citationsVerified.total}`);

if (process.env.SMOKE_SKIP_DRAFTING !== '1') {
  stage('Stage 1 — Drafting pipeline (4 roles)');
  const termSheet = (db.prepare(`SELECT content FROM documents WHERE id = 'doc-f3-termsheet'`).get() as { content: string }).content;
  const runId = startDraftingPipeline('fund-3', termSheet);
  let run = getRun(runId);
  const started = Date.now();
  while (run && run.status === 'running' && Date.now() - started < 15 * 60_000) {
    await new Promise((r) => setTimeout(r, 3_000));
    run = getRun(runId);
  }
  const result = run?.result as { sections?: Array<unknown>; citationsVerified?: { total: number; verified: number } } | undefined;
  check('pipeline completed', run?.status === 'done', run?.status === 'error' ? run.error : `${run?.events.length} events`);
  check('sections drafted', (result?.sections?.length ?? 0) >= 3, `${result?.sections?.length ?? 0} sections`);
  check('draft persisted to ontology', Boolean(db.prepare(`SELECT 1 FROM documents WHERE fund_id = 'fund-3' AND status = 'draft' AND title LIKE '%Engine Working Draft%'`).get()));
} else {
  console.log('\n(skipping drafting pipeline — SMOKE_SKIP_DRAFTING=1)');
}

stage('Degraded pass — Ollama unreachable');
(config.ollama as { baseUrl: string }).baseUrl = 'http://127.0.0.1:9';
resetHealthCache();
const degradedQa = await answerObligationQuery('Which investors have MFN election rights?');
check('Q&A still succeeds without Ollama', degradedQa.answer.length > 20);
const lastCall = db.prepare(`SELECT ner_used FROM ai_calls ORDER BY ts DESC, id DESC LIMIT 1`).get() as { ner_used: number };
check('NER assist reported off', lastCall.ner_used === 0);
check('citations still verified', degradedQa.citationsVerified.verified >= 1,
  `${degradedQa.citationsVerified.verified}/${degradedQa.citationsVerified.total}`);

console.log(`\n${failures === 0 ? '✓ smoke passed' : `✗ smoke failed (${failures} checks)`}`);
process.exit(failures === 0 ? 0 : 1);
