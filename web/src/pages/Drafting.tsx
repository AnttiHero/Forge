import { useEffect, useState } from 'react';
import { get, post, subscribeRun, type Citation, type RunEvent } from '../api.js';
import { SectionTitle, Button, CitationRow, ErrorNote, RunProgress } from '../components.js';

interface DraftResult {
  documentId: string;
  sections: Array<{ provisionId: string; heading: string; topic: string; text: string; citations: Citation[] }>;
  citationsVerified: { total: number; verified: number };
}

interface FeedbackResult {
  revisedText: string;
  changeSummary: string;
  citations: Citation[];
}

export function Drafting() {
  const [termSheet, setTermSheet] = useState('');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [result, setResult] = useState<DraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Record<string, FeedbackResult>>({});

  useEffect(() => {
    get<{ content: string }>('/documents/doc-f3-termsheet')
      .then((d) => setTermSheet(d.content))
      .catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    setEvents([]);
    setResult(null);
    setError(null);
    try {
      const { runId } = await post<{ runId: string }>('/draft', { fundId: 'fund-3', termSheetText: termSheet });
      subscribeRun(
        runId,
        (e) => setEvents((prev) => [...prev, e]),
        (end) => {
          setRunning(false);
          if (end.status === 'done') setResult(end.result as DraftResult);
          else setError(end.error ?? 'pipeline failed');
        },
      );
    } catch (e) {
      setRunning(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendFeedback = async (provisionId: string) => {
    const text = feedback[provisionId];
    if (!text) return;
    setFeedbackBusy(provisionId);
    try {
      const r = await post<FeedbackResult>(`/draft/sections/${provisionId}/feedback`, { feedback: text });
      setRevisions((prev) => ({ ...prev, [provisionId]: r }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFeedbackBusy(null);
    }
  };

  return (
    <div>
      <SectionTitle
        eyebrow="From term sheet to first draft"
        sub="Paste the agreed commercial terms. The engine drafts the operative sections from your model documents, your prior funds, and what investors pushed back on last time — and shows you the source of every sentence."
      >
        Drafting
      </SectionTitle>

      <textarea
        value={termSheet}
        onChange={(e) => setTermSheet(e.target.value)}
        rows={10}
        className="field w-full font-mono text-xs leading-relaxed"
      />
      <div className="mt-4 flex items-center gap-4">
        <Button onClick={run} busy={running} disabled={!termSheet}>
          Generate first draft
        </Button>
        <span className="text-xs text-fog">takes a few minutes — watch it work below</span>
      </div>
      <ErrorNote error={error} />

      {(running || events.length > 0) && (
        <div className="animate-fade-up mt-8">
          <RunProgress events={events} running={running} />
        </div>
      )}

      {result && (
        <div className="animate-fade-up mt-10">
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-bone">
              Drafted sections <span className="ml-2 font-mono text-[11px] font-normal text-fog">{result.documentId}</span>
            </h3>
            <span className="font-mono text-[10px] text-fog tabular-nums">
              {result.citationsVerified.verified}/{result.citationsVerified.total} citations verified
            </span>
          </div>
          <div className="stagger space-y-5">
            {result.sections.map((s) => {
              const rev = revisions[s.provisionId];
              return (
                <div key={s.provisionId} className="card p-6">
                  <h4 className="text-lg font-semibold tracking-tight">{s.heading}</h4>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-bone/90">{rev?.revisedText ?? s.text}</p>
                  <CitationRow citations={rev?.citations ?? s.citations} />
                  {rev && (
                    <p className="mt-3 rounded-xl bg-verdant/[0.08] px-3.5 py-2 text-xs leading-relaxed text-verdant">
                      Revised — {rev.changeSummary}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2.5">
                    <input
                      value={feedback[s.provisionId] ?? ''}
                      onChange={(e) => setFeedback((prev) => ({ ...prev, [s.provisionId]: e.target.value }))}
                      placeholder="Mark it up in a sentence — e.g. tighten the consent threshold to $75M"
                      className="field w-full flex-1 py-2 text-xs"
                    />
                    <Button
                      onClick={() => sendFeedback(s.provisionId)}
                      busy={feedbackBusy === s.provisionId}
                      disabled={!feedback[s.provisionId]}
                    >
                      Revise
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
