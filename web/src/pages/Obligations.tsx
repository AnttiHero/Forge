import { useEffect, useState } from 'react';
import { get, post, type Citation } from '../api.js';
import { SectionTitle, Button, CitationChip, ErrorNote, ThinkingCard } from '../components.js';

interface Answer {
  answer: string;
  checklist: Array<{ step: string; dueWithin: string | null; citation: Citation }>;
  affectedInvestors: string[];
  citations: Citation[];
  citationsVerified: { total: number; verified: number };
}

interface ExtractResult {
  obligations: Array<{ id: string; type: string; summary: string; geography: string | null; verified: boolean }>;
}

const SAMPLE = 'We have a time-sensitive new deal in sub-Saharan Africa. What obligations do we have?';

export function Obligations({ scopeFundId }: { scopeFundId?: string }) {
  const [question, setQuestion] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [extractDoc, setExtractDoc] = useState('');
  const [extractBusy, setExtractBusy] = useState(false);
  const [extracted, setExtracted] = useState<ExtractResult | null>(null);
  const [scopeName, setScopeName] = useState<string | null>(null);

  useEffect(() => {
    get<Array<{ id: string; title: string; status: string; type: string }>>('/documents')
      .then((all) => setDocs(all.filter((d) => d.status === 'closed')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!scopeFundId) {
      setScopeName(null);
      return;
    }
    get<{ name: string }>(`/funds/${scopeFundId}`).then((f) => setScopeName(f.name)).catch(() => setScopeName(null));
  }, [scopeFundId]);

  const ask = async () => {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await post<Answer>('/obligations/ask', { question, fundId: scopeFundId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const extract = async () => {
    if (!extractDoc) return;
    setExtractBusy(true);
    setError(null);
    try {
      setExtracted(await post<ExtractResult>(`/obligations/extract/${extractDoc}`, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtractBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle
        eyebrow="Ask what you've promised"
        sub="The fund closes; the promises run for a decade. Ask in plain English — who has excusal rights, what a new deal triggers, what's owed to whom. Every answer quotes the clause that created the duty, checked word-for-word against the document."
      >
        Obligations
      </SectionTitle>

      {scopeName && (
        <div className="animate-pop-in mb-3 inline-flex items-center gap-2 rounded-full border border-ember/30 bg-ember/[0.06] px-3 py-1 text-xs font-medium text-ember">
          <span className="h-1.5 w-1.5 rounded-full bg-ember" />
          Scoped to {scopeName}
        </div>
      )}
      <div className="flex gap-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && ask()}
          className="field w-full flex-1 py-3 text-[15px]"
          placeholder="Ask anything — e.g. which investors can opt out of defense deals?"
        />
        <Button onClick={ask} busy={busy}>
          Ask
        </Button>
      </div>
      <ErrorNote error={error} />

      {busy && <ThinkingCard label="Consulting the register" />}

      {answer && (
        <div className="mt-10 space-y-8">
          <div className="card-elevated animate-pop-in p-8">
            <p className="text-[15px] leading-relaxed">{answer.answer}</p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {answer.affectedInvestors.map((n) => (
                <span
                  key={n}
                  className="rounded-full border border-ember/25 bg-ember/[0.07] px-3 py-1 text-xs font-medium text-ember shadow-[0_1px_3px_rgba(196,95,63,0.12)]"
                >
                  {n}
                </span>
              ))}
              <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-fog tabular-nums">
                <span className={`h-1.5 w-1.5 rounded-full ${answer.citationsVerified.verified === answer.citationsVerified.total ? 'bg-verdant' : 'bg-warn'}`} />
                {answer.citationsVerified.verified}/{answer.citationsVerified.total} citations verified
              </span>
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-bone">Your checklist — most urgent first</h3>
            <div className="card overflow-hidden">
              <div className="stagger divide-y divide-black/[0.05]">
                {answer.checklist.map((s, i) => (
                  <div key={i} className="flex items-start gap-4 px-5 py-4 text-sm transition-colors hover:bg-black/[0.015]">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ember/12 font-mono text-[11px] font-semibold text-ember tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex-1 leading-relaxed">
                      {s.step}
                      {s.dueWithin && (
                        <span className="ml-2 inline-block rounded-full bg-warn/10 px-2.5 py-0.5 font-mono text-[10px] text-warn">
                          {s.dueWithin}
                        </span>
                      )}
                    </span>
                    <CitationChip citation={s.citation} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-14 border-t border-black/[0.07] pt-8">
        <h3 className="text-sm font-semibold text-bone">Pull the duties out of an executed document</h3>
        <p className="mb-4 mt-1 text-xs text-fog">
          Pick a signed document — every duty it creates is extracted and checked word-for-word against the text before it goes on file.
        </p>
        <div className="flex gap-3">
          <select value={extractDoc} onChange={(e) => setExtractDoc(e.target.value)} className="field w-full flex-1">
            <option value="">Choose a closed document…</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <Button onClick={extract} busy={extractBusy} disabled={!extractDoc}>
            Extract
          </Button>
        </div>
        {extractBusy && <ThinkingCard label="Reading the document" />}
        {extracted && (
          <div className="card mt-4 overflow-hidden">
            <div className="stagger divide-y divide-black/[0.05]">
              {extracted.obligations.map((o) => (
                <div key={o.id} className="flex items-baseline gap-3 px-5 py-3 text-xs">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ember">{o.type.replace(/_/g, ' ')}</span>
                  <span className="flex-1 leading-relaxed">{o.summary}</span>
                  <span className={`font-mono text-[10px] ${o.verified ? 'text-verdant' : 'text-warn'}`}>
                    {o.verified ? '✓ verbatim' : '✗ not found'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
