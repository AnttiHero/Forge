import { useEffect, useState } from 'react';
import { get, post, type Citation, type Fund } from '../api.js';
import { SectionTitle, Button, CitationChip, ErrorNote, ThinkingCard } from '../components.js';

interface Deadline {
  obligationId: string;
  fundId: string;
  fundName: string;
  investorName: string | null;
  type: string;
  summary: string;
  sourceClause: string;
  verified: boolean;
  cadence: string;
  periodLabel: string;
  dueDate: string;
  daysUntil: number;
  overdue: boolean;
  businessDays: boolean;
}

interface PlannedDuty {
  obligationId: string;
  fundName: string;
  investorName: string | null;
  type: string;
  summary: string;
  sourceClause: string;
  actionDate: string;
  direction: 'before' | 'after';
  daysUntil: number;
  overdue: boolean;
  leadDays: number;
  businessDays: boolean;
  matchedBy: string;
}

interface Email {
  subject: string;
  body: string;
  citations: Citation[];
  citationsVerified: { total: number; verified: number };
}

function CountdownChip({ daysUntil, overdue }: { daysUntil: number; overdue: boolean }) {
  const label = overdue ? `${Math.abs(daysUntil)}d overdue` : daysUntil === 0 ? 'today' : `in ${daysUntil}d`;
  const cls = overdue
    ? 'bg-[#b3261e]/10 text-[#b3261e] border-[#b3261e]/25'
    : daysUntil <= 14
      ? 'bg-ember/[0.08] text-ember border-ember/25'
      : 'bg-black/[0.04] text-fog border-black/[0.08]';
  return <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${cls}`}>{label}</span>;
}

function DueDateBlock({ iso }: { iso: string }) {
  const d = new Date(`${iso}T00:00:00Z`);
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return (
    <div className="w-12 shrink-0 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ember">{month}</div>
      <div className="text-xl font-semibold leading-tight tabular-nums">{d.getUTCDate()}</div>
      <div className="text-[10px] text-fog tabular-nums">{d.getUTCFullYear()}</div>
    </div>
  );
}

function EmailDraft({ email }: { email: Email }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="animate-pop-in mt-3 rounded-2xl border border-ember/20 bg-ember/[0.04] p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold">{email.subject}</p>
        <button onClick={copy} className="btn-ghost shrink-0">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mt-3 whitespace-pre-wrap font-sans text-xs leading-relaxed text-bone/90">{email.body}</pre>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {email.citations.map((c, i) => (
          <CitationChip key={i} citation={c} />
        ))}
        <span className="ml-auto font-mono text-[10px] text-fog tabular-nums">
          {email.citationsVerified.verified}/{email.citationsVerified.total} verified
        </span>
      </div>
    </div>
  );
}

export function Deadlines() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [fundId, setFundId] = useState('');
  const [withinDays, setWithinDays] = useState(180);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [eventDesc, setEventDesc] = useState('Closing a new investment in sub-Saharan Africa');
  const [eventDate, setEventDate] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [plan, setPlan] = useState<PlannedDuty[] | null>(null);

  const [emailBusy, setEmailBusy] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, Email>>({});

  useEffect(() => {
    get<Fund[]>('/funds').then(setFunds).catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (fundId) params.set('fundId', fundId);
    params.set('withinDays', String(withinDays));
    get<{ deadlines: Deadline[] }>(`/deadlines?${params}`)
      .then((r) => setDeadlines(r.deadlines))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [fundId, withinDays]);

  const runPlan = async () => {
    if (!eventDesc || !eventDate) return;
    setPlanBusy(true);
    setError(null);
    setPlan(null);
    try {
      const r = await post<{ duties: PlannedDuty[] }>('/deadlines/plan', {
        eventDescription: eventDesc,
        eventDate,
        fundId: fundId || undefined,
      });
      setPlan(r.duties);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanBusy(false);
    }
  };

  const draftEmail = async (key: string, obligationId: string, opts: { dueDate?: string; periodLabel?: string; eventDescription?: string }) => {
    setEmailBusy(key);
    setError(null);
    try {
      const email = await post<Email>('/deadlines/email', { obligationId, ...opts });
      setEmails((prev) => ({ ...prev, [key]: email }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEmailBusy(null);
    }
  };

  const icsHref = `/api/deadlines.ics?withinDays=365${fundId ? `&fundId=${fundId}` : ''}`;

  // group by month for the timeline feel
  const byMonth = deadlines.reduce<Record<string, Deadline[]>>((acc, d) => {
    const key = new Date(`${d.dueDate}T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    (acc[key] ??= []).push(d);
    return acc;
  }, {});

  return (
    <div>
      <SectionTitle
        eyebrow="Never miss a date"
        sub="Every recurring duty turned into a real due date — quarterly and annual anchors, business-day counting taken from the clause itself. Plan around a deal, draft the reminder email, or push the lot to your calendar."
      >
        Deadlines
      </SectionTitle>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="field py-2 text-sm">
          <option value="">All engagements</option>
          {funds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))} className="field py-2 text-sm">
          <option value={90}>Next 90 days</option>
          <option value={180}>Next 180 days</option>
          <option value={365}>Next year</option>
        </select>
        <a href={icsHref} download className="btn-ghost ml-auto">
          ⤓ Add to calendar (.ics)
        </a>
      </div>
      <ErrorNote error={error} />

      {/* Event planner */}
      <div className="card-elevated mb-10 p-7">
        <h3 className="text-sm font-semibold text-bone">Planning a deal or a closing?</h3>
        <p className="mt-1 text-xs leading-relaxed text-fog">
          Describe it and set the date — you get every notice, consent and report it triggers, each with its own latest-action date counted from the clause. Instant; no AI involved in the dates.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            value={eventDesc}
            onChange={(e) => setEventDesc(e.target.value)}
            className="field min-w-64 flex-1"
            placeholder="Describe the event…"
          />
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="field" />
          <Button onClick={runPlan} busy={planBusy} disabled={!eventDesc || !eventDate}>
            Plan
          </Button>
        </div>
        {plan && (
          <div className="stagger mt-5 space-y-3">
            {plan.map((d) => {
              const key = `plan-${d.obligationId}`;
              return (
                <div key={d.obligationId} className="rounded-2xl border border-black/[0.07] bg-surface p-4 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
                  <div className="flex items-start gap-4">
                    <DueDateBlock iso={d.actionDate} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CountdownChip daysUntil={d.daysUntil} overdue={d.overdue} />
                        <span className="rounded-full bg-black/[0.04] px-2 py-0.5 font-mono text-[10px] text-fog">
                          {d.leadDays} {d.businessDays ? 'business days' : 'days'} {d.direction} the event
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-ember">{d.type.replace(/_/g, ' ')}</span>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-relaxed">{d.summary}</p>
                      <p className="mt-1 text-xs text-fog">
                        {d.investorName ?? 'All LPs'} · {d.fundName}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <CitationChip citation={{ sourceType: 'obligation', sourceId: d.obligationId, quote: d.sourceClause }} />
                      <button
                        onClick={() => draftEmail(key, d.obligationId, { dueDate: d.actionDate, eventDescription: `${eventDesc} (event date ${eventDate})` })}
                        disabled={emailBusy !== null}
                        className="btn-ghost"
                      >
                        {emailBusy === key ? 'Drafting…' : '✉ Draft reminder'}
                      </button>
                    </div>
                  </div>
                  {emails[key] && <EmailDraft email={emails[key]} />}
                </div>
              );
            })}
            {plan.length === 0 && <p className="text-xs text-fog">No event-triggered obligations matched this event.</p>}
          </div>
        )}
      </div>

      {/* Upcoming recurring deadlines */}
      {Object.entries(byMonth).map(([month, items]) => (
        <div key={month} className="mb-8">
          <h3 className="mb-3 text-sm font-semibold text-bone">
            {month}
            <span className="ml-2 font-mono text-[11px] font-normal text-fog tabular-nums">{items.length}</span>
          </h3>
          <div className="stagger space-y-3">
            {items.map((d) => {
              const key = `${d.obligationId}-${d.dueDate}`;
              return (
                <div key={key} className="card card-hover p-4">
                  <div className="flex items-start gap-4">
                    <DueDateBlock iso={d.dueDate} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CountdownChip daysUntil={d.daysUntil} overdue={d.overdue} />
                        <span className="rounded-full bg-black/[0.04] px-2 py-0.5 font-mono text-[10px] text-fog">{d.periodLabel}</span>
                        <span className="rounded-full bg-black/[0.04] px-2 py-0.5 font-mono text-[10px] text-fog">{d.cadence}</span>
                        {d.businessDays && <span className="rounded-full bg-black/[0.04] px-2 py-0.5 font-mono text-[10px] text-fog">business days</span>}
                      </div>
                      <p className="mt-1.5 text-[13px] leading-relaxed">{d.summary}</p>
                      <p className="mt-1 text-xs text-fog">
                        {d.investorName ?? 'All LPs'} · {d.fundName}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <CitationChip citation={{ sourceType: 'obligation', sourceId: d.obligationId, quote: d.sourceClause }} />
                      <button
                        onClick={() => draftEmail(key, d.obligationId, { dueDate: d.dueDate, periodLabel: d.periodLabel })}
                        disabled={emailBusy !== null}
                        className="btn-ghost"
                      >
                        {emailBusy === key ? 'Drafting…' : '✉ Draft reminder'}
                      </button>
                    </div>
                  </div>
                  {emailBusy === key && <ThinkingCard label="Drafting the reminder" />}
                  {emails[key] && <EmailDraft email={emails[key]} />}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {deadlines.length === 0 && (
        <div className="card p-10 text-center text-sm text-fog">No deadlines in this window.</div>
      )}

      <p className="mt-6 text-[11px] leading-relaxed text-fog/80">
        Assumes a calendar fiscal year. Business-day math skips weekends but not public holidays — verify critical dates.
      </p>
    </div>
  );
}
