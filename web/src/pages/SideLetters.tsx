import { useEffect, useState } from 'react';
import { downloadDocx, get, post, type Citation } from '../api.js';
import { SectionTitle, Button, CitationRow, ErrorNote, ThinkingCard } from '../components.js';

interface Drafts {
  drafts: Array<{
    label: string;
    rationale: string;
    clauses: Array<{ term: string; tier: string; text: string; citations: Citation[] }>;
  }>;
  termRetrieval: Array<{ term: string; suggestedTier: string }>;
  citationsVerified: { total: number; verified: number };
}

const TIER_DOT: Record<string, string> = {
  model_language: 'bg-verdant',
  adapted_precedent: 'bg-warn',
  fresh_drafting: 'bg-ember',
};

const TIER_LABEL: Record<string, string> = {
  model_language: 'Model language',
  adapted_precedent: 'Adapted precedent',
  fresh_drafting: 'Fresh drafting',
};

const DEFAULT_TERMS = `Excusal from investments in EU-sanctioned or sub-investment-grade jurisdictions, including sub-Saharan Africa
15 Business Days advance notice of any proposed investment in an excused jurisdiction
Annual ESG report on the Invest Europe template`;

export function SideLetters() {
  const [investors, setInvestors] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [investorId, setInvestorId] = useState('inv-norrland');
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Drafts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Array<{ id: string; name: string; type: string }>>('/investors').then(setInvestors).catch(() => {});
  }, []);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await post<Drafts>('/side-letters/generate', {
          fundId: 'fund-3',
          investorId,
          agreedTerms: terms.split('\n').map((t) => t.trim()).filter(Boolean),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle
        eyebrow="Three ways to paper it"
        sub="List what you've agreed with the investor. You get three complete drafts side by side — one hewing to your model language, one adapted from executed precedent, one drafted fresh — and every clause is labelled with where its words came from."
      >
        Side Letters
      </SectionTitle>

      <div className="grid gap-6 md:grid-cols-3">
        <div>
          <label className="mb-2 block text-xs font-medium text-fog">Investor</label>
          <select value={investorId} onChange={(e) => setInvestorId(e.target.value)} className="field w-full">
            {investors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <div className="mt-4">
            <Button onClick={generate} busy={busy}>
              Generate three drafts
            </Button>
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="mb-2 block text-xs font-medium text-fog">What you've agreed — one term per line, plain English is fine</label>
          <textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={4}
            className="field w-full text-xs leading-relaxed"
          />
        </div>
      </div>
      <ErrorNote error={error} />

      {busy && <ThinkingCard label="Drafting three solutions" />}

      {result && (
        <div className="animate-fade-up mt-10">
          <div className="mb-4 flex flex-wrap items-center gap-5 text-xs text-fog">
            <span className="font-medium text-bone">Clause sourcing</span>
            {(['model_language', 'adapted_precedent', 'fresh_drafting'] as const).map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[t]}`} />
                {TIER_LABEL[t]}
              </span>
            ))}
            <span className="ml-auto flex items-center gap-3">
              <button
                onClick={async () => {
                  const investorName = investors.find((i) => i.id === investorId)?.name ?? 'Investor';
                  const fund = await get<{ name: string }>('/funds/fund-3');
                  await downloadDocx(
                    'side-letters',
                    { fundName: fund.name, investorName, drafts: result.drafts },
                    `Side Letter Drafts — ${investorName}.docx`,
                  );
                }}
                className="btn-ghost"
              >
                ⤓ Download .docx
              </button>
              <span className="font-mono text-[10px] tabular-nums">
                {result.citationsVerified.verified}/{result.citationsVerified.total} citations verified
              </span>
            </span>
          </div>
          <div className="stagger grid gap-5 lg:grid-cols-3">
            {result.drafts.map((d) => (
              <div key={d.label} className="card card-hover p-6">
                <h3 className="text-lg font-semibold tracking-tight">{TIER_LABEL[d.label] ?? d.label}</h3>
                <p className="mt-1 text-xs leading-relaxed text-fog">{d.rationale}</p>
                <div className="mt-5 space-y-4">
                  {d.clauses.map((c, i) => (
                    <div key={i} className="rounded-2xl border border-black/[0.08] bg-black/[0.025] p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-fog">{c.term}</span>
                        <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-fog">
                          <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[c.tier] ?? 'bg-fog'}`} />
                          {TIER_LABEL[c.tier] ?? c.tier}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-bone/90">{c.text}</p>
                      <CitationRow citations={c.citations} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
