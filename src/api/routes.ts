/**
 * Forge REST API + one SSE endpoint for pipeline progress.
 * Localhost-only by default; no auth — this is the lawyer's own machine.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb, withDbOp, genId } from '../db/db.js';
import { config } from '../config.js';
import * as ollama from '../ai/ollama.js';
import { answerObligationQuery, extractObligations } from '../engine/obligations.js';
import { listTriagedComments, suggestResolution, resolveComment, ingestComments } from '../engine/comments.js';
import { assessChange } from '../engine/changes.js';
import { generateSideLetterDrafts, executeSideLetter } from '../engine/side-letters.js';
import { startDraftingPipeline, integrateFeedback } from '../engine/drafting.js';
import { createMatter, ingestDocument } from '../engine/intake.js';
import { computeUpcomingDeadlines, deadlinesToICS, draftReminderEmail, planEvent } from '../engine/deadlines.js';
import { listPrecedents } from '../engine/precedent.js';
import { verifyCitationsDeep } from '../engine/citations.js';
import { buildCompendium } from '../engine/mfn.js';
import { mfnCompendiumDocx, sideLettersDocx } from '../export/docx.js';
import {
  activateWorkspace,
  createWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  lockWorkspace,
  unlockWorkspace,
} from '../workspaces/workspaces.js';
import { getRun, subscribe } from '../engine/progress.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerRoutes(app: FastifyInstance): void {
  // ── Health & degradation flags ─────────────────────────────────────
  app.get('/api/health', async () => {
    const ollamaUp = await ollama.isUp();
    const workspace = getActiveWorkspace();
    return {
      ok: true,
      model: config.anthropic.model,
      anthropicKey: Boolean(config.anthropic.apiKey),
      ollama: ollamaUp ? 'up' : 'down',
      workspace: { id: workspace.id, name: workspace.name },
      degraded: {
        anonymization: ollamaUp ? null : 'regex-only (no local NER assist)',
        search: ollamaUp ? null : 'keyword-only (no embeddings)',
      },
    };
  });

  // ── Matter workspaces — ethical walls ──────────────────────────────
  app.get('/api/workspaces', async () => listWorkspaces());

  app.post<{ Body: { name: string } }>('/api/workspaces', async (req, reply) => {
    if (!req.body?.name?.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      return createWorkspace(req.body.name);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/activate', async (req, reply) => {
    try {
      return activateWorkspace(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { passphrase: string } }>('/api/workspaces/:id/lock', async (req, reply) => {
    if (!req.body?.passphrase) return reply.code(400).send({ error: 'passphrase required' });
    try {
      return lockWorkspace(req.params.id, req.body.passphrase);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { passphrase: string } }>('/api/workspaces/:id/unlock', async (req, reply) => {
    if (!req.body?.passphrase) return reply.code(400).send({ error: 'passphrase required' });
    try {
      return unlockWorkspace(req.params.id, req.body.passphrase);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── Ontology reads ─────────────────────────────────────────────────
  app.get('/api/funds', async () => {
    const db = getDb();
    return db
      .prepare(
        `SELECT f.*, (SELECT COUNT(*) FROM commitments c WHERE c.fund_id = f.id) AS investor_count,
                (SELECT COALESCE(SUM(amount_usd), 0) FROM commitments c WHERE c.fund_id = f.id) AS committed_usd,
                (SELECT COUNT(*) FROM obligations o WHERE o.fund_id = f.id) AS obligation_count
         FROM funds f ORDER BY f.numeral`,
      )
      .all();
  });

  app.get<{ Params: { id: string } }>('/api/funds/:id', async (req, reply) => {
    const db = getDb();
    const fund = db.prepare(`SELECT * FROM funds WHERE id = ?`).get(req.params.id);
    if (!fund) return reply.code(404).send({ error: 'fund not found' });
    const investors = db
      .prepare(
        `SELECT i.*, c.amount_usd FROM commitments c JOIN investors i ON i.id = c.investor_id
         WHERE c.fund_id = ? ORDER BY c.amount_usd DESC`,
      )
      .all(req.params.id);
    const documents = db
      .prepare(`SELECT id, type, status, title, investor_id FROM documents WHERE fund_id = ? ORDER BY type, title`)
      .all(req.params.id);
    const obligations = db
      .prepare(
        `SELECT o.*, i.name AS investor_name, d.title AS document_title
         FROM obligations o LEFT JOIN investors i ON i.id = o.investor_id
         JOIN documents d ON d.id = o.source_document_id
         WHERE o.fund_id = ? ORDER BY o.type, o.id`,
      )
      .all(req.params.id);
    return { ...fund, investors, documents, obligations };
  });

  app.get('/api/investors', async () => {
    const db = getDb();
    return db.prepare(`SELECT * FROM investors ORDER BY name`).all();
  });

  // Real LPs enter through the front door — no more seed-only investor list.
  app.post<{ Body: { name: string; type?: string; jurisdiction?: string; fundId?: string; commitmentUsd?: number } }>(
    '/api/investors',
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'name required' });
      const INVESTOR_TYPES = ['pension', 'swf', 'endowment', 'insurer', 'fund_of_funds', 'family_office', 'dfi', 'other'];
      const type = req.body.type?.trim() || 'other';
      if (!INVESTOR_TYPES.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${INVESTOR_TYPES.join(', ')}` });
      }
      if (req.body.commitmentUsd !== undefined && (!Number.isFinite(req.body.commitmentUsd) || req.body.commitmentUsd < 0)) {
        return reply.code(400).send({ error: 'commitmentUsd must be a non-negative number' });
      }
      if (req.body.fundId) {
        const fund = getDb().prepare(`SELECT id FROM funds WHERE id = ?`).get(req.body.fundId);
        if (!fund) return reply.code(400).send({ error: 'unknown fundId' });
      }
      const db = getDb();
      const existing = db.prepare(`SELECT id FROM investors WHERE lower(name) = lower(?)`).get(name);
      if (existing) return reply.code(409).send({ error: 'investor already exists', id: (existing as { id: string }).id });
      const id = genId('inv');
      try {
        db.transaction(() => {
          db.prepare(`INSERT INTO investors (id, name, type, jurisdiction) VALUES (?, ?, ?, ?)`).run(
            id,
            name,
            type,
            req.body.jurisdiction?.trim() || '',
          );
          if (req.body.fundId) {
            db.prepare(`INSERT INTO commitments (fund_id, investor_id, amount_usd) VALUES (?, ?, ?)`).run(
              req.body.fundId,
              id,
              req.body.commitmentUsd ?? 0,
            );
          }
        })();
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
      return db.prepare(`SELECT * FROM investors WHERE id = ?`).get(id);
    },
  );

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (req, reply) => {
    const db = getDb();
    const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(req.params.id);
    if (!doc) return reply.code(404).send({ error: 'document not found' });
    const provisions = db.prepare(`SELECT * FROM provisions WHERE document_id = ? ORDER BY position`).all(req.params.id);
    return { ...doc, provisions };
  });

  app.get('/api/documents', async () => {
    const db = getDb();
    return db.prepare(`SELECT id, fund_id, type, status, title, investor_id FROM documents ORDER BY type, title`).all();
  });

  app.get<{ Params: { id: string } }>('/api/provisions/:id', async (req, reply) => {
    const db = getDb();
    const p = db.prepare(`SELECT * FROM provisions WHERE id = ?`).get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'provision not found' });
    return p;
  });

  // ── Stage 1: drafting pipeline ─────────────────────────────────────
  app.post<{ Body: { fundId: string; termSheetText: string } }>('/api/draft', async (req, reply) => {
    const { fundId, termSheetText } = req.body ?? ({} as { fundId: string; termSheetText: string });
    if (!fundId || !termSheetText) return reply.code(400).send({ error: 'fundId and termSheetText required' });
    const runId = startDraftingPipeline(fundId, termSheetText);
    return { runId };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return run;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', (req, reply: FastifyReply) => {
    const run = getRun(req.params.id);
    if (!run) {
      void reply.code(404).send({ error: 'run not found' });
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (data: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // Replay history, then stream live
    for (const event of run.events) send(event);
    if (run.status !== 'running') {
      send({ type: 'end', status: run.status, result: run.result, error: run.error });
      reply.raw.end();
      return;
    }
    const unsubscribe = subscribe(run.id, (event) => {
      if ('type' in event && event.type === 'end') {
        const current = getRun(run.id);
        send({ type: 'end', status: event.status, result: current?.result, error: current?.error });
        unsubscribe();
        reply.raw.end();
        return;
      }
      send(event);
    });
    req.raw.on('close', unsubscribe);
  });

  app.post<{ Params: { id: string }; Body: { feedback: string } }>(
    '/api/draft/sections/:id/feedback',
    async (req, reply) => {
      if (!req.body?.feedback) return reply.code(400).send({ error: 'feedback required' });
      try {
        return await withDbOp(() => integrateFeedback(req.params.id, req.body.feedback));
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  // ── Stage 2: change assessment ─────────────────────────────────────
  app.post<{ Body: { provisionId: string; changeRequest: string } }>('/api/changes/assess', async (req, reply) => {
    const { provisionId, changeRequest } = req.body ?? ({} as { provisionId: string; changeRequest: string });
    if (!provisionId || !changeRequest) return reply.code(400).send({ error: 'provisionId and changeRequest required' });
    try {
      return await withDbOp(() => assessChange(provisionId, changeRequest));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── Stage 3: comment triage ────────────────────────────────────────
  app.get<{ Querystring: { fundId?: string } }>('/api/comments', async (req, reply) => {
    if (!req.query.fundId) return reply.code(400).send({ error: 'fundId required' });
    return listTriagedComments(req.query.fundId);
  });

  app.post<{ Params: { id: string } }>('/api/comments/:id/suggest', async (req, reply) => {
    try {
      return await withDbOp(() => suggestResolution(req.params.id));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { action: 'accept' | 'edit'; text?: string } }>(
    '/api/comments/:id/resolve',
    async (req, reply) => {
      const action = req.body?.action;
      if (action !== 'accept' && action !== 'edit') return reply.code(400).send({ error: 'action must be accept or edit' });
      try {
        await withDbOp(() => resolveComment(req.params.id, action, req.body?.text));
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  // ── Stage 4: side letters ──────────────────────────────────────────
  app.post<{ Body: { fundId: string; investorId: string; agreedTerms: string[] } }>(
    '/api/side-letters/generate',
    async (req, reply) => {
      const { fundId, investorId, agreedTerms } = req.body ?? ({} as { fundId: string; investorId: string; agreedTerms: string[] });
      if (!fundId || !investorId || !Array.isArray(agreedTerms) || agreedTerms.length === 0) {
        return reply.code(400).send({ error: 'fundId, investorId and non-empty agreedTerms required' });
      }
      try {
        return await withDbOp(() => generateSideLetterDrafts({ fundId, investorId, agreedTerms }));
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  // Closing the loop: a chosen draft becomes an executed document, its
  // clauses become house precedent, its obligations enter the register —
  // and the MFN compendium sees it on the next run.
  app.post<{ Body: { fundId: string; investorId: string; draft: { label: string; clauses: Array<{ term: string; tier: string; text: string }> } } }>(
    '/api/side-letters/execute',
    async (req, reply) => {
      const { fundId, investorId, draft } = req.body ?? ({} as never);
      if (!fundId || !investorId || !draft?.label || !Array.isArray(draft?.clauses) || draft.clauses.length === 0) {
        return reply.code(400).send({ error: 'fundId, investorId and a draft with clauses required' });
      }
      try {
        return await withDbOp(() => executeSideLetter(getDb(), { fundId, investorId, draft }));
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  // Paste LP counsel's actual mark-up — atomized into the triage queue.
  app.post<{ Body: { fundId: string; investorId: string; text: string } }>('/api/comments', async (req, reply) => {
    const { fundId, investorId, text } = req.body ?? ({} as { fundId: string; investorId: string; text: string });
    if (!fundId || !investorId || !text) return reply.code(400).send({ error: 'fundId, investorId and text required' });
    try {
      return await withDbOp(() => ingestComments({ fundId, investorId, text }));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── Intake: bring your own documents ───────────────────────────────
  app.post<{ Body: { name: string; strategy?: string } }>('/api/matters', async (req, reply) => {
    if (!req.body?.name?.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      return createMatter(getDb(), { name: req.body.name, strategy: req.body.strategy });
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post('/api/documents/upload', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'a file is required' });
    const fundId = (file.fields.fundId as { value?: string } | undefined)?.value;
    const title = (file.fields.title as { value?: string } | undefined)?.value;
    const investorName = (file.fields.investorName as { value?: string } | undefined)?.value;
    if (!fundId) return reply.code(400).send({ error: 'fundId field required' });
    try {
      const buffer = await file.toBuffer();
      const db = getDb();
      // hold the workspace open for the whole parse → store → embed chain
      return await withDbOp(() =>
        ingestDocument(db, { fundId, buffer, filename: file.filename, mimeType: file.mimetype, title, investorName }),
      );
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── Stage 5: obligations ───────────────────────────────────────────
  app.post<{ Params: { documentId: string } }>('/api/obligations/extract/:documentId', async (req, reply) => {
    try {
      return await withDbOp(() => extractObligations(req.params.documentId));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post<{ Body: { question: string; fundId?: string } }>('/api/obligations/ask', async (req, reply) => {
    if (!req.body?.question) return reply.code(400).send({ error: 'question required' });
    try {
      return await withDbOp(() => answerObligationQuery(req.body.question, req.body.fundId));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── Deadlines: obligations that act ────────────────────────────────
  app.get<{ Querystring: { fundId?: string; withinDays?: string } }>('/api/deadlines', async (req) => {
    const withinDays = req.query.withinDays ? Number.parseInt(req.query.withinDays, 10) : undefined;
    return computeUpcomingDeadlines(getDb(), {
      fundId: req.query.fundId || undefined,
      withinDays: Number.isFinite(withinDays) ? withinDays : undefined,
    });
  });

  app.post<{ Body: { eventDescription: string; eventDate: string; fundId?: string } }>(
    '/api/deadlines/plan',
    async (req, reply) => {
      const { eventDescription, eventDate, fundId } = req.body ?? ({} as { eventDescription: string; eventDate: string; fundId?: string });
      if (!eventDescription || !eventDate) return reply.code(400).send({ error: 'eventDescription and eventDate required' });
      try {
        return await withDbOp(() => planEvent(getDb(), { eventDescription, eventDate, fundId }));
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  app.post<{ Body: { obligationId: string; dueDate?: string; periodLabel?: string; eventDescription?: string } }>(
    '/api/deadlines/email',
    async (req, reply) => {
      if (!req.body?.obligationId) return reply.code(400).send({ error: 'obligationId required' });
      try {
        return await withDbOp(() =>
          draftReminderEmail(req.body.obligationId, {
            dueDate: req.body.dueDate,
            periodLabel: req.body.periodLabel,
            eventDescription: req.body.eventDescription,
          }),
        );
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  app.get<{ Querystring: { fundId?: string; withinDays?: string } }>('/api/deadlines.ics', async (req, reply) => {
    const withinDays = req.query.withinDays ? Number.parseInt(req.query.withinDays, 10) : undefined;
    const { deadlines } = computeUpcomingDeadlines(getDb(), {
      fundId: req.query.fundId || undefined,
      withinDays: Number.isFinite(withinDays) ? withinDays : 365,
    });
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="forge-obligations.ics"')
      .send(deadlinesToICS(deadlines));
  });

  // ── House precedent — what the engine has learned ──────────────────
  app.get('/api/precedents', async () => listPrecedents(getDb()));

  // ── MFN compendium ──────────────────────────────────────────────────
  app.post<{ Body: { fundId: string; deliveryDate?: string } }>('/api/mfn/compendium', async (req, reply) => {
    if (!req.body?.fundId) return reply.code(400).send({ error: 'fundId required' });
    try {
      return await withDbOp(() => buildCompendium(getDb(), { fundId: req.body.fundId, deliveryDate: req.body.deliveryDate }));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // ── DOCX export — Word-native deliverables ─────────────────────────
  app.post<{ Body: { kind: 'mfn-compendium' | 'side-letters'; payload: unknown; filename?: string } }>(
    '/api/export/docx',
    async (req, reply) => {
      const { kind, payload } = req.body ?? ({} as { kind: string; payload: unknown });
      if (!kind || !payload) return reply.code(400).send({ error: 'kind and payload required' });
      try {
        // never trust client-sent verification marks — re-verify every
        // citation against the ontology before the ✓/✗ goes into a document
        verifyCitationsDeep(getDb(), payload);
        const buffer =
          kind === 'mfn-compendium'
            ? await mfnCompendiumDocx(payload as Parameters<typeof mfnCompendiumDocx>[0])
            : kind === 'side-letters'
              ? await sideLettersDocx(payload as Parameters<typeof sideLettersDocx>[0])
              : null;
        if (!buffer) return reply.code(400).send({ error: `unknown kind: ${kind}` });
        // keep Unicode letters/numbers; strip only the double-quote, path
        // separators and control chars (the value is an HTTP header, never a path)
        // eslint-disable-next-line no-control-regex
        const filename =
          (req.body.filename ?? `forge-${kind}.docx`).replace(/["/\\\x00-\x1f]/g, '').trim() || `forge-${kind}.docx`;
        return reply
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(buffer);
      } catch (err) {
        return reply.code(400).send({ error: errMessage(err) });
      }
    },
  );

  // ── Privacy panel: what left your machine ──────────────────────────
  app.get('/api/privacy/calls', async () => {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, ts, stage, model, entity_stats_json, ner_used, duration_ms, input_tokens, output_tokens, ok
         FROM ai_calls ORDER BY ts DESC, id DESC LIMIT 100`,
      )
      .all();
  });

  app.get<{ Params: { id: string } }>('/api/privacy/calls/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM ai_calls WHERE id = ?`).get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'call not found' });
    return row;
  });
}
