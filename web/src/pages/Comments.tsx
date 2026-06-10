import { useEffect, useState } from 'react';
import { get, post, type Citation } from '../api.js';
import { SectionTitle, Button, CitationRow, ErrorNote } from '../components.js';

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
  const [grouped, setGrouped] = useState<Record<string, Comment[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = () => get<Record<string, Comment[]>>('/comments?fundId=fund-3').then(setGrouped).catch(() => {});
  useEffect(() => {
    load();
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

  const total = Object.values(grouped).flat().length;
  const open = Object.values(grouped).flat().filter((c) => c.status === 'open').length;

  return (
    <div>
      <SectionTitle
        eyebrow="Negotiation · your call, faster"
        sub={`Every investor comment, sorted by deal point instead of by inbox. For each one, the engine proposes a response grounded in your model terms and that investor's own precedent — you accept, edit, or ignore it. ${total} comments on Fund III, ${open} still open.`}
      >
        Investor Comments
      </SectionTitle>
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
      </div>
    </div>
  );
}
