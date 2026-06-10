import { useEffect, useState } from 'react';
import { get, usd, type Fund, type Obligation } from '../api.js';
import { SectionTitle, CountUpUsd } from '../components.js';

interface FundDetail extends Fund {
  investors: Array<{ id: string; name: string; type: string; jurisdiction: string; amount_usd: number }>;
  documents: Array<{ id: string; type: string; status: string; title: string }>;
  obligations: Obligation[];
}

interface DeadlineLite {
  obligationId: string;
  fundName: string;
  summary: string;
  dueDate: string;
  daysUntil: number;
  overdue: boolean;
  periodLabel: string;
}

const TYPE_COLORS: Record<string, string> = {
  excuse: 'text-ember',
  notice: 'text-warn',
  reporting: 'text-verdant',
  consent: 'text-ember',
  mfn: 'text-fog',
  transfer_restriction: 'text-fog',
  investment_restriction: 'text-warn',
};

const DOC_TYPE_LABEL: Record<string, string> = {
  lpa: 'LPA',
  side_letter: 'Side letter',
  term_sheet: 'Term sheet',
  model_doc: 'Model',
};

/** "Needs your attention" — the 9am answer, with links into the work. */
function AttentionStrip({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [deadlines, setDeadlines] = useState<DeadlineLite[]>([]);
  const [openComments, setOpenComments] = useState<{ count: number; fundName: string } | null>(null);

  useEffect(() => {
    get<{ deadlines: DeadlineLite[] }>('/deadlines?withinDays=60')
      .then((r) => setDeadlines(r.deadlines))
      .catch(() => {});
    // open investor comments across forming funds
    get<Fund[]>('/funds')
      .then(async (funds) => {
        for (const f of funds.filter((x) => x.status === 'forming')) {
          try {
            const grouped = await get<Record<string, Array<{ status: string }>>>(`/comments?fundId=${f.id}`);
            const count = Object.values(grouped).flat().filter((c) => c.status === 'open').length;
            if (count > 0) {
              setOpenComments({ count, fundName: f.name.replace(', L.P.', '') });
              return;
            }
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {});
  }, []);

  const overdue = deadlines.filter((d) => d.overdue);
  const upcoming = deadlines.filter((d) => !d.overdue).slice(0, 3);
  const empty = overdue.length === 0 && upcoming.length === 0 && !openComments;

  return (
    <div className="card-elevated animate-pop-in mb-10 p-7">
      <h3 className="text-sm font-semibold text-bone">Needs your attention</h3>
      {empty ? (
        <p className="mt-3 text-sm text-fog">Nothing due in the next 60 days, and no open investor comments. Enjoy it.</p>
      ) : (
        <div className="stagger mt-4 divide-y divide-black/[0.05]">
          {overdue.map((d) => (
            <button
              key={`${d.obligationId}-${d.dueDate}`}
              onClick={() => onNavigate('deadlines')}
              className="group flex w-full items-center gap-3 py-3 text-left"
            >
              <span className="rounded-full border border-[#b3261e]/25 bg-[#b3261e]/10 px-2.5 py-0.5 font-mono text-[10px] font-medium text-[#b3261e] tabular-nums">
                {Math.abs(d.daysUntil)}d overdue
              </span>
              <span className="flex-1 text-sm leading-snug">
                {d.summary} <span className="text-fog">· {d.periodLabel} · {d.fundName.replace(', L.P.', '')}</span>
              </span>
              <span className="text-fog transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          ))}
          {upcoming.map((d) => (
            <button
              key={`${d.obligationId}-${d.dueDate}`}
              onClick={() => onNavigate('deadlines')}
              className="group flex w-full items-center gap-3 py-3 text-left"
            >
              <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${d.daysUntil <= 14 ? 'border-ember/25 bg-ember/[0.08] text-ember' : 'border-black/[0.08] bg-black/[0.04] text-fog'}`}>
                in {d.daysUntil}d
              </span>
              <span className="flex-1 text-sm leading-snug">
                {d.summary} <span className="text-fog">· {d.periodLabel} · {d.fundName.replace(', L.P.', '')}</span>
              </span>
              <span className="text-fog transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          ))}
          {openComments && (
            <button onClick={() => onNavigate('comments')} className="group flex w-full items-center gap-3 py-3 text-left">
              <span className="rounded-full border border-ember/25 bg-ember/[0.08] px-2.5 py-0.5 font-mono text-[10px] font-medium text-ember tabular-nums">
                {openComments.count} open
              </span>
              <span className="flex-1 text-sm leading-snug">
                Investor comments awaiting your response <span className="text-fog">· {openComments.fundName}</span>
              </span>
              <span className="text-fog transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Ontology({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [selected, setSelected] = useState<string>('fund-2');
  const [detail, setDetail] = useState<FundDetail | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('');

  useEffect(() => {
    get<Fund[]>('/funds').then(setFunds).catch(() => {});
  }, []);
  useEffect(() => {
    get<FundDetail>(`/funds/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  const obligations = detail?.obligations.filter((o) => !typeFilter || o.type === typeFilter) ?? [];
  const types = [...new Set(detail?.obligations.map((o) => o.type) ?? [])];

  return (
    <div>
      <SectionTitle
        eyebrow="Your practice"
        sub="Your funds, the investors in them, the documents you signed — and everything those documents oblige you to do. Every answer the engine gives is quoted back to what's on file here."
      >
        Overview
      </SectionTitle>

      <AttentionStrip onNavigate={onNavigate} />

      <div className="stagger mb-10 grid gap-4 md:grid-cols-3">
        {funds.map((f) => (
          <button
            key={f.id}
            onClick={() => setSelected(f.id)}
            className={`card card-hover p-6 text-left ${selected === f.id ? 'ring-2 ring-ember/50 ring-offset-2 ring-offset-page' : ''}`}
          >
            <div className="text-lg font-semibold tracking-tight">{f.name.replace(', L.P.', '')}</div>
            <div className="mt-1 text-xs text-fog">
              {f.vintage > 0 ? `${f.vintage} · ${f.status === 'forming' ? 'raising' : 'closed'}` : f.status === 'forming' ? 'raising' : f.status}
            </div>
            <div className="mt-5 flex items-end justify-between">
              <div>
                <div className="text-[2rem] font-semibold leading-none tracking-tight">
                  <CountUpUsd value={f.target_size_usd} />
                </div>
                <div className="mt-1.5 text-[11px] text-fog">target size</div>
              </div>
              <div className="text-right text-[11px] leading-relaxed text-fog tabular-nums">
                {f.investor_count} investors · {usd(f.committed_usd)}
                <br />
                {f.obligation_count} ongoing obligations
              </div>
            </div>
          </button>
        ))}
      </div>

      {detail && (
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="animate-fade-up">
            <h3 className="mb-3 text-sm font-semibold text-bone">Investors</h3>
            <div className="card overflow-hidden">
              <table className="w-full text-left text-xs">
                <tbody>
                  {detail.investors.map((i) => (
                    <tr key={i.id} className="border-b border-black/[0.05] transition-colors last:border-0 hover:bg-black/[0.02]">
                      <td className="px-4 py-2.5 font-medium">{i.name}</td>
                      <td className="px-2 py-2.5 text-fog">
                        {i.type.replace(/_/g, ' ')} · {i.jurisdiction}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{usd(i.amount_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="mb-3 mt-8 text-sm font-semibold text-bone">Documents on file</h3>
            <div className="card divide-y divide-black/[0.05] overflow-hidden">
              {detail.documents.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-black/[0.02]">
                  <span className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[10px] text-fog">
                    {DOC_TYPE_LABEL[d.type] ?? d.type}
                  </span>
                  <span className="flex-1">{d.title}</span>
                  <span className="text-fog">{d.status === 'closed' ? 'executed' : d.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="animate-fade-up">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-bone">What this fund has promised</h3>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="field py-1.5 text-xs">
                <option value="">All duties</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="stagger space-y-3" key={`${selected}-${typeFilter}`}>
              {obligations.map((o) => (
                <div key={o.id} className="card card-hover p-4 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[10px] uppercase tracking-wider ${TYPE_COLORS[o.type] ?? 'text-fog'}`}>
                      {o.type.replace(/_/g, ' ')}
                    </span>
                    {o.geography && (
                      <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] text-fog">{o.geography}</span>
                    )}
                    {o.notice_days != null && (
                      <span className="rounded-full bg-black/[0.05] px-2 py-0.5 font-mono text-[10px] text-fog tabular-nums">
                        {o.notice_days}d
                      </span>
                    )}
                    <span className={`ml-auto font-mono text-[10px] ${o.verified ? 'text-verdant' : 'text-warn'}`}>
                      {o.verified ? '✓ on file' : '✗ unverified'}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-bone">{o.summary}</p>
                  <p className="mt-1.5 text-fog">
                    Owed to {o.investor_name ?? 'all investors'} · {o.document_title}
                  </p>
                </div>
              ))}
              {obligations.length === 0 && (
                <div className="card p-8 text-center text-xs text-fog">
                  Nothing on file yet for this fund — upload its documents under <span className="font-medium text-bone">Documents</span>.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="mt-10 text-[11px] leading-relaxed text-fog/80">
        About the marks: <span className="font-mono text-verdant">✓</span> means the quoted language appears word-for-word in
        the source document on file. <span className="font-mono text-warn">✗</span> means it doesn't — treat it as unproven and
        check the source yourself. The engine never hides which is which.
      </p>
    </div>
  );
}
