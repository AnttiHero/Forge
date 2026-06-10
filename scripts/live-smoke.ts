import { z } from 'zod';
import { openDb, setDb } from '../src/db/db.js';
import { seedDatabase } from '../src/seed/seed.js';
import { callStructured } from '../src/ai/claude.js';
import { citationSchema } from '../src/engine/citations.js';

const db = openDb('./data/live-smoke.db');
await seedDatabase(db, { embeddings: false });
setDb(db);

const schema = z.object({
  answer: z.string(),
  citations: z.array(citationSchema),
});

const result = await callStructured({
  stage: 'live.smoke',
  system: 'You answer questions about fund obligations. The user message contains an obligation record. Cite it: every citation quote must be copied verbatim from the provided source text, and sourceType/sourceId must match the record. Be brief.',
  user: 'Obligation record [sourceType: obligation, sourceId: obl-01]: "Norrland Pension AB shall be excused from participation in any Portfolio Investment in a Portfolio Company whose principal operations are located in a jurisdiction that is subject to European Union restrictive measures or that is rated below investment grade by at least two internationally recognized rating agencies, including for the avoidance of doubt any jurisdiction in sub-Saharan Africa so rated." Question: is this investor excused from sub-Saharan Africa deals?',
  schema,
  maxTokens: 2000,
  effort: 'medium',
});

console.log('ANSWER:', result.data.answer.slice(0, 300));
console.log('CITATIONS:', JSON.stringify(result.data.citations, null, 2).slice(0, 600));
console.log('VERIFIED:', JSON.stringify(result.citations), 'nerUsed:', result.nerUsed, 'ms:', result.durationMs);
