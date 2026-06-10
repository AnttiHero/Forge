import { useEffect, useState } from 'react';
import { get, post, type Citation } from '../api.js';
import { SectionTitle, Button, CitationChip, CitationRow, ErrorNote, ThinkingCard } from '../components.js';

interface Assessment {
  currentReading: string;
  marketExamples: Array<{ characterization: string; citation: Citation }>;
  alternatives: Array<{ label: string; draftText: string; tradeoffs: string; citations: Citation[] }>;
  citationsVerified: { total: number; verified: number };
}

const SAMPLE_CHANGE = 'The managing partner wants to expand the geographic mandate to include emerging markets.';

export function Changes() {
  const [provisions, setProvisions] = useState<Array<{ id: string; heading: string; text: string }>>([]);
  const [provisionId, setProvisionId] = useState('p-f3-geo');
  const [request, setRequest] = useState(SAMPLE_CHANGE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Assessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ provisions: Array<{ id: string; heading: string; text: string }> }>('/documents/doc-f3-draft')
      .then((d) => setProvisions(d.provisions))
      .catch(() => {});
  }, []);

  const current = provisions.find((p) => p.id === provisionId);

  const assess = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post<Assessment>('/changes/assess', { provisionId, changeRequest: request }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle
        eyebrow="When the deal changes"
        sub="The client wants to change a term mid-raise. Pick the provision, say what's changing — the engine reads what it currently says, shows how your prior funds and side letters handled the same ground, and gives you drafting alternatives, most conservative first."
      >
        Term Changes
      </SectionTitle>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-xs font-medium text-fog">Which provision? (Fund III working draft)</label>
          <select value={provisionId} onChange={(e) => setProvisionId(e.target.value)} className="field w-full">
            {provisions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.heading}
              </option>
            ))}
          </select>
          {current && <p className="card mt-3 p-4 text-xs leading-relaxed text-fog">{current.text}</p>}
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-fog">What's changing?</label>
          <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={4} className="field w-full" />
          <div className="mt-3">
            <Button onClick={assess} busy={busy}>
              Assess the change
            </Button>
          </div>
        </div>
      </div>
      <ErrorNote error={error} />

      {busy && <ThinkingCard label="Assessing the change" />}

      {result && (
        <div className="animate-fade-up mt-10 space-y-8">
          <div className="card-elevated p-7">
            <h3 className="mb-2 text-sm font-semibold text-bone">What the provision currently does</h3>
            <p className="text-sm leading-relaxed text-bone/90">{result.currentReading}</p>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-bone">How your own documents have handled this</h3>
            <div className="card divide-y divide-black/[0.06] overflow-hidden">
              {result.marketExamples.map((m, i) => (
                <div key={i} className="flex items-start gap-4 px-5 py-3.5 text-sm">
                  <span className="flex-1 leading-relaxed">{m.characterization}</span>
                  <CitationChip citation={m.citation} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-bone">Menu of alternatives — most conservative first</h3>
              <span className="font-mono text-[10px] text-fog tabular-nums">
                {result.citationsVerified.verified}/{result.citationsVerified.total} citations verified
              </span>
            </div>
            <div className="stagger space-y-4">
              {result.alternatives.map((a, i) => (
                <div key={i} className="card card-hover p-6">
                  <h4 className="text-lg font-semibold tracking-tight text-ember">
                    {i + 1}. {a.label}
                  </h4>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-bone/90">{a.draftText}</p>
                  <p className="mt-3 text-xs leading-relaxed text-fog">{a.tradeoffs}</p>
                  <CitationRow citations={a.citations} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
