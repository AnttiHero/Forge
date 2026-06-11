import { useEffect, useRef, useState } from 'react';
import { get, usd, type Citation, type Health, type RunEvent } from './api.js';

// ── CountUp — numbers that arrive, Apple-style ──────────────────────────

export function useCountUp(target: number, duration = 850): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || target === 0) {
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

export function CountUpUsd({ value }: { value: number }) {
  const v = useCountUp(value);
  return <span className="tabular-nums">{usd(Math.round(v))}</span>;
}

// ── WorkspaceSwitcher — one case file open at a time ─────────────────────

interface WorkspaceMeta {
  id: string;
  name: string;
  locked: boolean;
}

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [newName, setNewName] = useState('');
  const [passFor, setPassFor] = useState<{ id: string; mode: 'lock' | 'unlock' } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((d: { activeId: string; workspaces: WorkspaceMeta[] }) => {
        setActiveId(d.activeId);
        setWorkspaces(d.workspaces);
      })
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  const act = async (path: string, body?: unknown) => {
    setError(null);
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      return false;
    }
    return true;
  };

  const active = workspaces.find((w) => w.id === activeId);

  return (
    <span className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost max-w-52"
        title={`${active?.name ?? 'Workspace'} — matter workspaces are separate, walled-off files`}
      >
        <span className="text-fog">⊟</span>
        <span className="truncate">{active?.name ?? 'Workspace'}</span>
        <span className="text-fog">▾</span>
      </button>
      {open && (
        <div className="animate-pop-in absolute right-0 top-full z-40 mt-2 w-80 rounded-2xl border border-black/[0.08] bg-surface p-3 shadow-[0_8px_24px_rgba(0,0,0,0.10),0_28px_70px_rgba(0,0,0,0.16)]">
          <p className="px-2 pb-2 pt-1 text-[11px] leading-relaxed text-fog">
            Matter workspaces are separate files — an ethical wall. Only the open one is readable.
          </p>
          {workspaces.map((w) => (
            <div key={w.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-xs hover:bg-black/[0.03]">
              <button
                disabled={w.locked}
                onClick={async () => {
                  if (await act(`/workspaces/${w.id}/activate`)) window.location.reload();
                }}
                className={`flex-1 text-left ${w.locked ? 'text-fog/60' : 'font-medium text-bone'}`}
              >
                {w.id === activeId ? '● ' : ''}
                {w.name}
                {w.locked ? ' 🔒' : ''}
              </button>
              {w.id !== 'default' && (
                <button
                  onClick={() => {
                    setPassFor({ id: w.id, mode: w.locked ? 'unlock' : 'lock' });
                    setPassphrase('');
                  }}
                  className="text-[11px] text-fog hover:text-ember"
                >
                  {w.locked ? 'Unlock' : 'Lock'}
                </button>
              )}
            </div>
          ))}
          {passFor && (
            <div className="mt-2 flex gap-2 border-t border-black/[0.06] px-2 pt-3">
              <input
                type="password"
                autoFocus
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && passphrase) {
                    if (await act(`/workspaces/${passFor.id}/${passFor.mode}`, { passphrase })) {
                      setPassFor(null);
                      await load();
                    }
                  }
                }}
                placeholder={`Passphrase to ${passFor.mode}… (Enter)`}
                className="field w-full flex-1 py-1.5 text-xs"
              />
            </div>
          )}
          <div className="mt-2 flex gap-2 border-t border-black/[0.06] px-2 pt-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  if (await act('/workspaces', { name: newName.trim() })) {
                    setNewName('');
                    await load();
                  }
                }
              }}
              placeholder="New matter workspace… (Enter)"
              className="field w-full flex-1 py-1.5 text-xs"
            />
          </div>
          {error && <p className="px-2 pt-2 text-[11px] text-warn">{error}</p>}
        </div>
      )}
    </span>
  );
}

// ── StatusBadge ──────────────────────────────────────────────────────────

export function StatusBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => get<Health>('/health').then((h) => alive && setHealth(h)).catch(() => alive && setHealth(null));
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!health) return <span className="text-xs text-fog">connecting…</span>;
  const degraded = health.ollama === 'down';
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-black/[0.08] bg-surface px-3.5 py-1.5 text-xs font-medium text-fog shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      title={degraded ? `${health.degraded.anonymization}; ${health.degraded.search}` : `local model connected · ${health.model}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${degraded ? 'bg-warn' : 'animate-ping bg-verdant'}`} />
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${degraded ? 'bg-warn' : 'bg-verdant'}`} />
      </span>
      {degraded ? 'Degraded' : 'On-device privacy'}
    </span>
  );
}

/** A first-run without an API key should explain itself, not 400. */
export function EngineKeyBanner() {
  const [keyMissing, setKeyMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => get<Health>('/health').then((h) => alive && setKeyMissing(!h.anthropicKey)).catch(() => {});
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!keyMissing) return null;
  return (
    <div className="border-b border-warn/25 bg-warn/[0.07] px-6 py-2.5 text-center text-xs leading-relaxed text-warn">
      The engine is asleep — no <code className="font-mono">ANTHROPIC_API_KEY</code> in <code className="font-mono">.env</code>.
      Browsing, search and the register work; drafting, Q&A and extraction need the key. Add it and restart{' '}
      <code className="font-mono">npm run dev</code>.
    </div>
  );
}

// ── CitationChip ─────────────────────────────────────────────────────────

export function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const ok = citation.verified !== false;
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-tight transition-all duration-200 hover:-translate-y-px ${
          ok
            ? 'border-black/10 bg-black/[0.03] text-fog hover:border-ember/50 hover:text-ember hover:shadow-[0_2px_8px_rgba(196,95,63,0.18)]'
            : 'border-warn/40 bg-warn/[0.06] text-warn'
        }`}
        title={ok ? 'Citation verified against source' : 'Quote NOT found in cited source'}
      >
        {citation.sourceId} {ok ? '✓' : '✗'}
      </button>
      {open && (
        <span className="animate-pop-in absolute left-0 top-full z-30 mt-2 block w-80 rounded-2xl border border-black/[0.08] bg-surface p-4 text-xs leading-relaxed text-bone shadow-[0_4px_12px_rgba(0,0,0,0.08),0_24px_60px_rgba(0,0,0,0.16)]">
          <span className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] text-fog">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? 'bg-verdant' : 'bg-warn'}`} />
            {citation.sourceType} · {citation.sourceId} · {ok ? 'verified verbatim' : 'unverified'}
          </span>
          “{citation.quote}”
        </span>
      )}
    </span>
  );
}

export function CitationRow({ citations }: { citations?: Citation[] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-1.5">
      {citations.map((c, i) => (
        <CitationChip key={i} citation={c} />
      ))}
    </span>
  );
}

// ── ThinkingCard — honest progress for the long calls ────────────────────

const THINKING_STEPS = [
  'Masking names on your device',
  'Searching the register locally',
  'Reasoning over cited sources',
  'Verifying every quote verbatim',
];

export function ThinkingCard({ label = 'Working on it' }: { label?: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, THINKING_STEPS.length - 1)), 7_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="card animate-pop-in mt-6 p-6">
      <div className="flex items-center gap-3">
        <span className="spinner spinner-light h-4 w-4" />
        <span className="shimmer-text text-sm font-medium">{label}</span>
      </div>
      <div className="shimmer-bar mt-4 h-1 w-full" />
      <p className="mt-3 font-mono text-[11px] text-fog">{THINKING_STEPS[step]}…</p>
    </div>
  );
}

// ── RunProgress — the pipeline as a living timeline ──────────────────────

const STAGE_LABELS: Record<string, [string, string]> = {
  'insight-capturer': ['Insight capturer', 'mining prior comments & precedent'],
  extractor: ['Extractor', 'structuring model-document language'],
  drafter: ['Drafter', 'drawing new provisions'],
  persist: ['Save', 'writing the draft into the ontology (no AI)'],
};

const STAGES = ['insight-capturer', 'extractor', 'drafter', 'persist'];

export function RunProgress({ events, running }: { events: RunEvent[]; running: boolean }) {
  const stageState = (stage: string): 'pending' | 'active' | 'done' => {
    const evts = events.filter((e) => e.stage === stage);
    if (evts.some((e) => e.status === 'done')) return 'done';
    if (evts.length > 0) return 'active';
    return 'pending';
  };
  const doneCount = STAGES.filter((s) => stageState(s) === 'done').length;
  const activeIndex = STAGES.findIndex((s) => stageState(s) === 'active');
  const progress = (doneCount + (activeIndex >= 0 ? 0.5 : 0)) / STAGES.length;
  const lastDetail = [...events].reverse().find((e) => e.detail)?.detail;

  return (
    <div className="card p-6">
      <div className="relative">
        {/* connector rail + animated fill */}
        <div className="absolute bottom-3 left-[11px] top-3 w-px bg-black/[0.08]" />
        <div
          className="absolute left-[11px] top-3 w-px bg-ember transition-[height] duration-700 ease-out"
          style={{ height: `calc(${Math.min(progress, 1) * 100}% - 1.5rem)` }}
        />
        <div className="space-y-5">
          {STAGES.map((s) => {
            const st = stageState(s);
            const [name, sub] = STAGE_LABELS[s];
            return (
              <div key={s} className="relative flex items-center gap-4 pl-0">
                {st === 'done' ? (
                  <span className="animate-check-pop z-10 flex h-6 w-6 items-center justify-center rounded-full bg-verdant text-[11px] font-semibold text-white shadow-[0_2px_8px_rgba(26,127,55,0.35)]">
                    ✓
                  </span>
                ) : st === 'active' ? (
                  <span className="animate-halo z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 border-ember bg-surface">
                    <span className="h-2 w-2 animate-pulse-ember rounded-full bg-ember" />
                  </span>
                ) : (
                  <span className="z-10 h-6 w-6 rounded-full border border-black/[0.12] bg-surface" />
                )}
                <div className="leading-tight">
                  <span className={`block text-sm font-medium transition-colors duration-300 ${st === 'pending' ? 'text-fog' : 'text-bone'}`}>
                    {name}
                  </span>
                  <span className="block text-xs text-fog">{sub}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {running && lastDetail && (
        <p className="mt-5 border-t border-black/[0.07] pt-3.5 font-mono text-[11px] text-fog">{lastDetail}</p>
      )}
    </div>
  );
}

// ── PrivacyPanel ─────────────────────────────────────────────────────────

interface AiCall {
  id: string;
  ts: string;
  stage: string;
  model: string;
  entity_stats_json: string;
  ner_used: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  ok: number;
}

function highlightPlaceholders(text: string) {
  const parts = text.split(/(\[[A-Z]+_\d+\])/g);
  return parts.map((p, i) =>
    /^\[[A-Z]+_\d+\]$/.test(p) ? (
      <mark key={i} className="rounded bg-ember/15 px-0.5 font-medium text-ember">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function PrivacyPanel({ onClose }: { onClose: () => void }) {
  const [calls, setCalls] = useState<AiCall[]>([]);
  const [selected, setSelected] = useState<(AiCall & { sanitized_prompt: string }) | null>(null);

  useEffect(() => {
    get<AiCall[]>('/privacy/calls').then(setCalls).catch(() => setCalls([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="animate-backdrop-in fixed inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass animate-sheet-in h-full w-full max-w-2xl overflow-y-auto border-l border-black/[0.08] p-8 shadow-[-24px_0_80px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-bone">What left your machine</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-fog transition-all hover:rotate-90 hover:bg-black/10 hover:text-bone"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="mb-6 max-w-md text-sm leading-relaxed text-fog">
          Every frontier call, with the exact sanitized payload. Fund and investor names are replaced on-device before anything is
          sent; <mark className="rounded bg-ember/15 px-0.5 text-ember">placeholders</mark> are restored locally on the way back.
        </p>
        <p className="mb-6 max-w-md rounded-xl border border-black/[0.07] bg-black/[0.025] px-4 py-3 text-xs leading-relaxed text-fog">
          What this does <span className="font-semibold text-bone">not</span> mask: the legal text itself — amounts, dates, clause
          language — travels in clear, because that's what makes verbatim citations checkable. Names the ontology doesn't know
          (counterparties, individuals inside documents) are caught by the local model's NER pass when it's running; the badge
          above goes amber when it isn't.
        </p>
        {selected ? (
          <div className="animate-fade-up">
            <button onClick={() => setSelected(null)} className="mb-4 text-xs font-medium text-ember hover:underline">
              ← All calls
            </button>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-fog">
              <span>{selected.stage}</span>
              <span>{selected.model}</span>
              <span>{(selected.duration_ms / 1000).toFixed(1)}s</span>
              <span>
                {selected.input_tokens} in / {selected.output_tokens} out
              </span>
              <span>NER {selected.ner_used ? 'on' : 'off'}</span>
            </div>
            <pre className="card whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-bone">
              {highlightPlaceholders(selected.sanitized_prompt)}
            </pre>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="text-fog">
                <tr className="border-b border-black/[0.07]">
                  <th className="px-4 py-2.5 font-medium">Stage</th>
                  <th className="px-2 py-2.5 font-medium">Masked</th>
                  <th className="px-2 py-2.5 font-medium">NER</th>
                  <th className="px-2 py-2.5 font-medium">Tokens</th>
                  <th className="px-4 py-2.5 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {calls.map((c) => {
                  const stats = JSON.parse(c.entity_stats_json) as Record<string, number>;
                  const masked = Object.values(stats).reduce((a, b) => a + b, 0);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => get<AiCall & { sanitized_prompt: string }>(`/privacy/calls/${c.id}`).then(setSelected)}
                      className="cursor-pointer border-b border-black/[0.05] transition-colors last:border-0 hover:bg-black/[0.03]"
                    >
                      <td className="px-4 py-2.5 font-mono">{c.stage}</td>
                      <td className="px-2 py-2.5 tabular-nums">{masked}</td>
                      <td className="px-2 py-2.5">
                        {c.ner_used ? <span className="text-verdant">on</span> : <span className="text-warn">off</span>}
                      </td>
                      <td className="px-2 py-2.5 font-mono tabular-nums">
                        {c.input_tokens}/{c.output_tokens}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{(c.duration_ms / 1000).toFixed(1)}s</td>
                    </tr>
                  );
                })}
                {calls.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-fog">
                      No frontier calls yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────

export function SectionTitle({
  children,
  sub,
  eyebrow,
}: {
  children: React.ReactNode;
  sub?: string;
  eyebrow?: string;
}) {
  return (
    <div className="mb-10">
      {eyebrow && (
        <p className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ember">
          <span className="inline-block h-px w-6 bg-ember/60" />
          {eyebrow}
        </p>
      )}
      <h1 className="text-4xl font-semibold tracking-[-0.03em] text-bone md:text-5xl">{children}</h1>
      {sub && <p className="mt-3.5 max-w-2xl text-base leading-relaxed text-fog">{sub}</p>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  busy,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled || busy} className="btn">
      {busy && <span className="spinner" />}
      {busy ? 'Working' : children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="animate-pop-in mt-3 rounded-xl border border-warn/30 bg-warn/[0.07] px-4 py-2.5 text-xs text-warn">{error}</p>
  );
}
