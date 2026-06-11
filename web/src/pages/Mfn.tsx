import { useEffect, useState } from 'react';
import { downloadDocx, get, post, usd, type Citation, type Fund } from '../api.js';
import { SectionTitle, Button, CitationChip, ErrorNote, ThinkingCard } from '../components.js';

interface Compendium {
  fundId: string;
  fundName: string;
  basis: { sourceType: string; sourceId: string; sourceClause: string } | null;
  thresholdUsd: number | null;
  windowDays: number | null;
  deliveryDate: string | null;
  electionDeadline: string | null;
  electors: Array<{ investorId: string; name: string; type: string; commitmentUsd: number }>;
  thresholdUnparsed?: boolean;
  entries: Array<{
    provisionId: string;
    granteeName: string;
    topic: string;
    heading: string;
    text: string;
    classification: 'electable' | 'excluded_recipient_specific';
    rationale: string;
    citation: Citation;
    electableBy: string[];
  }>;
  citationsVerified: { total: number; verified: number };
}

export function Mfn() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [fundId, setFundId] = useState('fund-2');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Compendium | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Fund[]>('/funds').then(setFunds).catch(() => {});
  }, []);

  const build = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post<Compendium>('/mfn/compendium', { fundId, deliveryDate: deliveryDate || undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const electable = result?.entries.filter((e) => e.classification === 'electable').length ?? 0;

  return (
    <div>
      <SectionTitle
        eyebrow="Most favored nation"
        sub="The compendium, assembled for you: every side-letter provision in the fund, who is entitled to elect it, what's excluded as investor-specific — with the reasoning written out and cited — and the election deadline counted from your delivery date."
      >
        MFN Compendium
      </SectionTitle>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-fog">Fund</label>
          <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="field py-2 text-sm">
            {funds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-fog">Compendium delivery date (optional)</label>
          <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className="field py-2 text-sm" />
        </div>
        <Button onClick={build} busy={busy}>
          Build compendium
        </Button>
      </div>
      <ErrorNote error={error} />

      {busy && <ThinkingCard label="Assembling the compendium" />}

      {result && (
        <div className="mt-10 space-y-8">
          {/* Basis */}
          <div className="card-elevated animate-pop-in p-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-bone">MFN basis — {result.fundName}</h3>
                {result.basis && (
                  <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fog">“{result.basis.sourceClause}”</p>
                )}
              </div>
              {result.basis && (
                <CitationChip
                  citation={{ sourceType: result.basis.sourceType as Citation['sourceType'], sourceId: result.basis.sourceId, quote: result.basis.sourceClause }}
                />
              )}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-4">
              <div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">
                  {result.thresholdUsd != null ? usd(result.thresholdUsd) : '—'}
                </div>
                <div className="mt-0.5 text-[11px] text-fog">eligibility threshold</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{result.windowDays ?? '—'}d</div>
                <div className="mt-0.5 text-[11px] text-fog">election window</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{result.electors.length}</div>
                <div className="mt-0.5 text-[11px] text-fog">eligible electors</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">
                  {result.electionDeadline ?? '—'}
                </div>
                <div className="mt-0.5 text-[11px] text-fog">
                  {result.electionDeadline ? 'election deadline' : 'set a delivery date for the deadline'}
                </div>
              </div>
            </div>
            {result.thresholdUnparsed && (
              <p className="mt-4 rounded-xl border border-warn/25 bg-warn/[0.06] px-4 py-2.5 text-xs leading-relaxed text-warn">
                The MFN clause sets a monetary eligibility test that couldn't be read automatically — eligible electors are{' '}
                <span className="font-semibold">unknown</span>, not zero. Read the basis clause above and determine eligibility by hand.
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {result.electors.map((e) => (
                <span key={e.investorId} className="rounded-full border border-black/[0.09] bg-black/[0.03] px-3 py-1 text-xs">
                  {e.name} <span className="font-mono text-[10px] text-fog tabular-nums">{usd(e.commitmentUsd)}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Entries */}
          <div>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-bone">
                {result.entries.length} provisions · {electable} electable, {result.entries.length - electable} excluded as recipient-specific
              </h3>
              <span className="flex items-center gap-3">
                <button
                  onClick={() => void downloadDocx('mfn-compendium', result, `MFN Compendium — ${result.fundName.replace(/, L\.P\.$/, '')}.docx`)}
                  className="btn-ghost"
                >
                  ⤓ Download .docx
                </button>
                <span className="font-mono text-[10px] text-fog tabular-nums">
                  {result.citationsVerified.verified}/{result.citationsVerified.total} citations verified
                </span>
              </span>
            </div>
            <div className="stagger space-y-4">
              {result.entries.map((e) => (
                <div key={e.provisionId} className="card card-hover p-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                        e.classification === 'electable' ? 'bg-verdant/12 text-verdant' : 'bg-warn/12 text-warn'
                      }`}
                    >
                      {e.classification === 'electable' ? 'ELECTABLE' : 'EXCLUDED — RECIPIENT-SPECIFIC'}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-fog">{e.topic.replace(/_/g, ' ')}</span>
                    <span className="ml-auto text-xs text-fog">
                      granted to <span className="font-medium text-bone">{e.granteeName}</span>
                    </span>
                  </div>
                  <h4 className="mt-3 text-sm font-semibold">{e.heading}</h4>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-bone/90">{e.text}</p>
                  <p className="mt-3 text-xs leading-relaxed text-fog">
                    <span className="font-medium text-bone">Why:</span> {e.rationale}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <CitationChip citation={e.citation} />
                    {e.classification === 'electable' && (
                      <span className="text-[11px] text-fog">
                        · electable by {e.electableBy.length}: {e.electableBy.join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
