/**
 * Cassie, the in-app guide. A floating avatar that opens a small chat:
 * ask how anything works, what needs attention, or where to do something,
 * and she answers in plain language with a button to the right tab.
 * The avatar is generated locally (no third-party request), and her calls
 * go through the same privacy gateway and audit as everything else.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';
import { post } from './api.js';

interface Turn {
  role: 'user' | 'cassie';
  text: string;
  suggestedTab?: string | null;
  suggestedTabLabel?: string | null;
  followUps?: string[];
}

interface HelperReply {
  answer: string;
  suggestedTab: string | null;
  suggestedTabLabel: string | null;
  followUps: string[];
}

const GREETING: Turn = {
  role: 'cassie',
  text: "I'm Cassie. I know every corner of Forge: what each tab does, how the privacy model works, and what's on file right now. Ask me anything.",
  followUps: ['What needs my attention today?', 'How do I add my own contract?', 'What does "citations verified" mean?'],
};

export function Helper({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([GREETING]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const avatar = useMemo(
    () =>
      createAvatar(notionists, {
        seed: 'Cassie Caslon',
        backgroundColor: ['f4f3ef'],
      }).toDataUri(),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy, open]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setDraft('');
    setError(null);
    setBusy(true);
    const history = [...turns.filter((t) => t !== GREETING)];
    setTurns((prev) => [...prev, { role: 'user', text: q }]);
    try {
      const r = await post<HelperReply>('/helper', {
        question: q,
        history: history.slice(-8).map((t) => ({ role: t.role, text: t.text })),
      });
      setTurns((prev) => [
        ...prev,
        {
          role: 'cassie',
          text: r.answer,
          suggestedTab: r.suggestedTab,
          suggestedTabLabel: r.suggestedTabLabel,
          followUps: r.followUps,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* the door */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Ask Cassie, the in-app guide"
          aria-label="Open the in-app guide"
          className="group fixed bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full border border-black/[0.08] bg-surface shadow-[0_2px_6px_rgba(27,26,24,0.08),0_12px_32px_rgba(27,26,24,0.16)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_4px_10px_rgba(27,26,24,0.1),0_20px_48px_rgba(27,26,24,0.22)] active:scale-95"
        >
          <img src={avatar} alt="" className="h-11 w-11 rounded-full" />
          <span className="absolute -top-0.5 right-0 h-3 w-3 rounded-full border-2 border-surface bg-verdant" />
        </button>
      )}

      {/* the room */}
      {open && (
        <div className="animate-pop-in fixed bottom-6 right-6 z-30 flex max-h-[calc(100vh-6rem)] w-[24rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-3xl border border-black/[0.08] bg-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(27,26,24,0.06),0_24px_60px_rgba(27,26,24,0.18),0_64px_140px_rgba(27,26,24,0.22)]">
          <div className="glass hairline-b flex items-center gap-3 px-5 py-3.5">
            <img src={avatar} alt="" className="h-9 w-9 rounded-full border border-black/[0.06]" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-bone">Cassie</div>
              <div className="truncate text-[11px] text-fog">Knows the whole system. Calls are masked and audited.</div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-xs text-fog transition-all hover:rotate-90 hover:bg-black/10 hover:text-bone"
            >
              ✕
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {turns.map((t, i) => (
              <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    t.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-md bg-ember px-3.5 py-2.5 text-[13px] leading-relaxed text-white shadow-[0_2px_8px_rgba(125,47,63,0.25)]'
                      : 'max-w-[88%] rounded-2xl rounded-bl-md border border-black/[0.06] bg-page px-3.5 py-2.5 text-[13px] leading-relaxed text-bone'
                  }
                >
                  {t.text}
                  {t.role === 'cassie' && t.suggestedTab && (
                    <div className="mt-2.5">
                      <button
                        onClick={() => {
                          onNavigate(t.suggestedTab!);
                          setOpen(false);
                        }}
                        className="btn px-3.5 py-1.5 text-xs"
                      >
                        Take me to {t.suggestedTabLabel ?? 'it'} →
                      </button>
                    </div>
                  )}
                  {t.role === 'cassie' && (t.followUps?.length ?? 0) > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {t.followUps!.map((f, j) => (
                        <button
                          key={j}
                          onClick={() => void ask(f)}
                          disabled={busy}
                          className="rounded-full border border-black/[0.1] bg-surface px-2.5 py-1 text-[11px] text-fog transition-all hover:border-ember/40 hover:text-ember"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-[12px] text-fog">
                <span className="spinner spinner-light" />
                <span className="shimmer-text">Thinking</span>
              </div>
            )}
            {error && <p className="px-1 text-[11px] text-warn">{error}</p>}
          </div>

          <div className="hairline-b border-t border-black/[0.06] p-3">
            <div className="flex gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void ask(draft)}
                placeholder="Ask about anything in Forge…"
                className="field w-full flex-1 py-2 text-[13px]"
              />
              <button onClick={() => void ask(draft)} disabled={busy || !draft.trim()} className="btn px-4 py-2 text-sm">
                Ask
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
