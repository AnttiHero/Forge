import { useCallback, useEffect, useState } from 'react';
import { get, post, type Citation, type Fund } from '../api.js';
import { SectionTitle, Button, CitationRow, ErrorNote, ThinkingCard } from '../components.js';

interface Comment {
  id: string;
  investorName: string;
  investorType: string;
  text: string;
  status: string;
  suggestedResolution: string | null;
  suggestionCitations: Citation[] | null;
  resolutionText: string | null;
  resolvedBy: string | null;
}

export function Comments() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [fundId, setFundId] = useState('fund-3');
  const [grouped, setGrouped] = useState<Record<string, Comment[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [investors, setInvestors] = useState<Array<{ id: string; name: string }>>([]);
  const [ingestInvestorId, setIngestInvestorId] = useState('');
  const [ingestText, setIngestText] = useState('');
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingested, setIngested] = useState<{ count: number; topics: string[]; skippedDuplicates: number } | null>(null);

  const load = useCallback(
    () => get<Record<string, Comment[]>>(`/comments?fundId=${fundId}`).then(setGrouped).catch(() => {}),
    [fundId],
  );
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    get<Fund[]>('/funds')
      .then((all) => {
        setFunds(all);
        if (all.length > 0 && !all.some((f) => f.id === 'fund-3')) setFundId(all[0].id);
      })
      .catch(() => {});
    get<Array<{ id: string; name: string }>>('/investors').then(setInvestors).catch(() => {});
  }, []);

  const suggest = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await post(`/comments/${id}/suggest`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (id: string, action: 'accept' | 'edit') => {
    setError(null);
    try {
      await post(`/comments/${id}/resolve`, { action, text: action === 'edit' ? editing[id] : undefined });
      setEditing((prev) => ({ ...prev, [id]: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const ingest = async () => {
    if (!ingestInvestorId || !ingestText.trim()) return;
    setIngestBusy(true);
    setError(null);
    setIngested(null);
    try {
      const r = await post<{ count: number; topics: string[]; skippedDuplicates: number }>('/comments', {
        fundId,
        investorId: ingestInvestorId,
        text: ingestText,
      });
      setIngested(r);
      setIngestText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngestBusy(false);
    }
  };

  const total = Object.values(grouped).flat().length;
  const open = Object.values(grouped).flat().filter((c) => c.status === 'open').length;
  const fundName = funds.find((f) => f.id === fundId)?.name ?? 'this fund';

  return (
    <div>
      <SectionTitle
        eyebrow="Negotiation · your call, faster"
        sub={`Every investor comment, sorted by deal point instead of by inbox. For each one, the engine proposes a response grounded in your model terms and that investor's own precedent — you accept, edit, or ignore it. ${total} comments on ${fundName}, ${open} still open.`}
      >
        Investor Comments
      </SectionTitle>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="field py-2 text-sm">
          {funds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      {/* Bring real comments in — the queue runs on what LP counsel actually sent */}
      <div className="card mb-10 p-7">
        <h3 className="text-sm font-semibold text-bone">Add investor comments</h3>
        <p className="mt-1 text-xs leading-relaxed text-fog">
          Paste LP counsel's mark-up, email, or comment memo. It's split into individual deal-point comments and joins the triage queue
          below. Names are masked on this machine before any AI sees a word.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <select value={ingestInvestorId} onChange={(e) => setIngestInvestorId(e.target.value)} className="field min-w-52">
            <option value="">Whose comments?</option>
            {investors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <textarea
            value={ingestText}
            onChange={(e) => setIngestText(e.target.value)}
            rows={3}
            placeholder="Paste the mark-up or email here…"
            className="field min-w-64 flex-1 text-xs leading-relaxed"
          />
          <Button onClick={ingest} busy={ingestBusy} disabled={!ingestInvestorId || ingestText.trim().length < 20}>
            Add to queue
          </Button>
        </div>
        {ingestBusy && <ThinkingCard label="Splitting the mark-up into deal points" />}
        {ingested && (
          <p className="animate-fade-up mt-3 text-xs text-verdant">
            ✓ {ingested.count} comment{ingested.count === 1 ? '' : 's'} added
            {ingested.topics.length > 0
              ? ` across ${ingested.topics.length} deal point${ingested.topics.length === 1 ? '' : 's'}: ${ingested.topics.map((t) => t.replace(/_/g, ' ')).join(', ')}`
              : ''}
            {ingested.skippedDuplicates > 0 ? ` — ${ingested.skippedDuplicates} already in the queue, skipped` : ''}
          </p>
        )}
      </div>
      <ErrorNote error={error} />

      <div className="space-y-12">
        {Object.entries(grouped).map(([topic, comments]) => (
          <div key={topic}>
            <h3 className="mb-4 text-xl font-semibold capitalize tracking-tight text-bone">
              {topic.replace(/_/g, ' ')}
              <span className="ml-2 align-middle font-mono text-[11px] font-normal text-fog">{comments.length}</span>
            </h3>
            <div className="stagger space-y-4">
              {comments.map((c) => (
                <div key={c.id} className="card p-6">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-bone">{c.investorName}</span>
                    <span className="text-fog">{c.investorType.replace(/_/g, ' ')}</span>
                    <span
                      className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        c.status === 'resolved'
                          ? 'bg-verdant/12 text-verdant'
                          : c.status === 'suggested'
                            ? 'bg-ember/12 text-ember'
                            : 'bg-black/[0.05] text-fog'
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-bone/90">{c.text}</p>

                  {c.status === 'open' && (
                    <div className="mt-4">
                      <Button onClick={() => suggest(c.id)} busy={busy === c.id}>
                        Propose a response
                      </Button>
                    </div>
                  )}

                  {c.status === 'suggested' && c.suggestedResolution && (
                    <div className="animate-fade-up mt-4 rounded-2xl border border-ember/20 bg-ember/[0.05] p-5">
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-bone/90">{c.suggestedResolution}</p>
                      <CitationRow citations={c.suggestionCitations ?? undefined} />
                      <div className="mt-4 flex items-center gap-2.5">
                        <Button onClick={() => resolve(c.id, 'accept')}>Accept</Button>
                        <input
                          value={editing[c.id] ?? ''}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          placeholder="…or write it your way"
                          className="field w-full flex-1 py-2 text-xs"
                        />
                        <button onClick={() => resolve(c.id, 'edit')} disabled={!editing[c.id]} className="btn-ghost whitespace-nowrap">
                          Save edit
                        </button>
                      </div>
                    </div>
                  )}

                  {c.status === 'resolved' && (
                    <div className="mt-4 rounded-2xl border border-verdant/20 bg-verdant/[0.05] p-5">
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-bone/90">{c.resolutionText}</p>
                      <p className="mt-2 font-mono text-[10px] text-verdant">
                        {c.resolvedBy === 'lawyer_accepted' ? '✓ accepted by lawyer' : '✓ edited by lawyer'}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {total === 0 && (
          <div className="card p-10 text-center text-sm text-fog">No comments on {fundName} yet — paste a mark-up above to start.</div>
        )}
      </div>
    </div>
  );
}
