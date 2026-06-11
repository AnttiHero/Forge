/**
 * Cassie, the in-app guide. One helper that knows the whole system: every
 * tab, the privacy model, and the live state of the open client file. She
 * answers questions about how Forge works and what needs attention, and
 * points at the right tab. For questions about the legal content of
 * documents she routes to the Obligations register, which answers with
 * verified citations; Cassie herself never invents legal substance.
 *
 * Her calls go through the same gateway as everything else: names are
 * masked before the question and the practice snapshot leave the machine,
 * and the call lands in the "What left your machine" audit.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getDb } from '../db/db.js';
import { callStructured } from '../ai/claude.js';
import { computeUpcomingDeadlines } from './deadlines.js';

const TAB_KEYS = [
  'ontology',
  'intake',
  'drafting',
  'changes',
  'comments',
  'side-letters',
  'obligations',
  'deadlines',
  'mfn',
] as const;

export const TAB_LABELS: Record<(typeof TAB_KEYS)[number], string> = {
  ontology: 'Overview',
  intake: 'Documents',
  drafting: 'Drafting',
  changes: 'Changes',
  comments: 'Comments',
  'side-letters': 'Side Letters',
  obligations: 'Obligations',
  deadlines: 'Deadlines',
  mfn: 'MFN',
};

const SYSTEM = `You are Cassie, the in-app guide for Forge, a local-first fund formation engine for lawyers. Answer briefly and warmly in plain language (two to four sentences for most questions). Never use em dashes. You know the whole system:

THE SHAPE OF THE APP
One fund is picked once in the header (or by clicking a fund card on Overview) and every page acts on it. A "client file" (the other header control) is a separate walled-off database; only the open one is readable, and closed ones can be locked with a passphrase. The tabs follow the life of a fund: Overview and Documents (your practice and files), then Drafting, Changes, Comments, Side Letters (raising), then Obligations, Deadlines, MFN (living with what was signed).

WHAT EACH TAB DOES
- Overview (tab key: ontology): fund cards, what needs attention today (overdue and upcoming duties, open comments), what the engine has learned as precedent.
- Documents (intake): create a fund, upload an LPA or side letter (PDF, Word, Markdown, text; scanned PDFs are OCR'd on-device). Every duty in the document is pulled out and checked word-for-word before it goes on file. Name the investor at upload to link side letters to their LP.
- Drafting: paste a term sheet, get drafted LPA sections from the model library and prior funds, revise per section with one-line feedback.
- Changes: pick a provision, say what is changing, get the current reading, how prior documents handled the same ground, and drafting alternatives.
- Comments: paste LP counsel's mark-up; it is split into deal-point comments. The engine proposes responses citing model language and the investor's own precedent; the lawyer accepts, edits, or ignores. Accepted and edited resolutions become house precedent.
- Side Letters: list agreed terms, get three complete drafts (model language, adapted precedent, fresh drafting), every clause labelled with where its words came from. Mark the signed one as executed: it is filed, its clauses become precedent, its duties enter the register, the MFN compendium sees it. Exports to Word.
- Obligations: ask the register questions in plain English; answers cite the clause that created each duty, verified verbatim. Also pull duties out of any closed document. This is where questions about the CONTENT of documents belong.
- Deadlines: real due dates for recurring duties, an event planner (describe a deal, get every notice it triggers), drafted reminder emails, iCalendar export.
- MFN: the compendium for a fund: eligibility threshold and election window parsed from the fund's own clause, who can elect what, electable versus recipient-specific with cited reasoning. Exports to Word.

PRIVACY, PRECISELY
Fund and investor names are masked on the lawyer's machine before any frontier call; a local model catches names the ontology has never seen. The legal text itself (amounts, dates, clause language) travels in clear because that is what makes verbatim citation checking possible. The "Privacy" button in the header shows the exact payload of every call; its dot is green and breathing when local masking is fully active, amber when degraded to regex-only (local model down). "N/N citations verified" means each quote was machine-checked word-for-word against the document on file.

RULES
- If the question is about the legal content of documents on file (who has which rights, what a deal triggers, what a clause says), do not answer the substance yourself. Briefly say the Obligations register answers that with verified citations and set suggestedTab to "obligations".
- If a question is about live numbers, answer from the PRACTICE SNAPSHOT you are given; do not invent figures.
- When an action would help, set suggestedTab to the tab where it happens (use the tab key, not the label). Otherwise set it to null.
- Offer up to three short follow-up questions a lawyer might naturally ask next.
- If you do not know, say so plainly.`;

const helperSchema = z.object({
  answer: z.string().describe('The reply, two to four plain sentences for most questions'),
  suggestedTab: z
    .enum([...TAB_KEYS, 'none'])
    .describe('Tab key where the user should go next, or "none"'),
  followUps: z.array(z.string()).describe('Up to three short follow-up questions, empty if none fit'),
});

export interface HelperTurn {
  role: 'user' | 'cassie';
  text: string;
}

export interface HelperReply {
  answer: string;
  suggestedTab: string | null;
  suggestedTabLabel: string | null;
  followUps: string[];
}

/** A compact, current picture of the open client file. */
function practiceSnapshot(db: Database.Database): string {
  const funds = db.prepare(`SELECT id, name, status FROM funds ORDER BY numeral`).all() as Array<{
    id: string;
    name: string;
    status: string;
  }>;
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM investors) AS investors,
              (SELECT COUNT(*) FROM documents) AS documents,
              (SELECT COUNT(*) FROM obligations) AS obligations,
              (SELECT COUNT(*) FROM comments WHERE status = 'open') AS openComments,
              (SELECT COUNT(*) FROM precedents) AS precedents`,
    )
    .get() as { investors: number; documents: number; obligations: number; openComments: number; precedents: number };
  let nextDeadline = 'none in the next 45 days';
  try {
    const { deadlines } = computeUpcomingDeadlines(db, { withinDays: 45 });
    if (deadlines.length > 0) {
      const d = deadlines[0];
      nextDeadline = `${d.summary} (due ${d.dueDate}${d.overdue ? ', OVERDUE' : ''})`;
    }
  } catch {
    /* deadline math must never break the helper */
  }
  return [
    `Funds on file: ${funds.map((f) => `${f.name} (${f.status})`).join('; ') || 'none yet'}`,
    `Investors: ${counts.investors} · documents: ${counts.documents} · obligations on the register: ${counts.obligations}`,
    `Open investor comments: ${counts.openComments} · house precedents learned: ${counts.precedents}`,
    `Nearest deadline: ${nextDeadline}`,
  ].join('\n');
}

export async function askHelper(opts: { question: string; history?: HelperTurn[] }): Promise<HelperReply> {
  const question = opts.question?.trim();
  if (!question) throw new Error('Ask a question first.');
  if (question.length > 2_000) throw new Error('Keep the question under 2,000 characters.');
  const db = getDb();

  const history = (opts.history ?? [])
    .slice(-8)
    .map((t) => `${t.role === 'user' ? 'Lawyer' : 'Cassie'}: ${t.text}`)
    .join('\n');

  const result = await callStructured({
    stage: 'helper.ask',
    system: SYSTEM,
    user: `PRACTICE SNAPSHOT (live, from the open client file):\n${practiceSnapshot(db)}\n\n${
      history ? `CONVERSATION SO FAR:\n${history}\n\n` : ''
    }LAWYER'S QUESTION:\n${question}`,
    schema: helperSchema,
    maxTokens: 1_500,
    effort: 'low',
  });

  const tab = result.data.suggestedTab !== 'none' && TAB_KEYS.includes(result.data.suggestedTab as never)
    ? result.data.suggestedTab
    : null;
  return {
    answer: result.data.answer,
    suggestedTab: tab,
    suggestedTabLabel: tab ? TAB_LABELS[tab as (typeof TAB_KEYS)[number]] : null,
    followUps: result.data.followUps.slice(0, 3),
  };
}
