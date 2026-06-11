import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Intro, shouldPlayIntro } from './Intro.js';
import { StatusBadge, PrivacyPanel, WorkspaceSwitcher, EngineKeyBanner } from './components.js';
import { Ontology } from './pages/Ontology.js';
import { Intake } from './pages/Intake.js';
import { Drafting } from './pages/Drafting.js';
import { Changes } from './pages/Changes.js';
import { Comments } from './pages/Comments.js';
import { SideLetters } from './pages/SideLetters.js';
import { Obligations } from './pages/Obligations.js';
import { Deadlines } from './pages/Deadlines.js';
import { Mfn } from './pages/Mfn.js';

// ordered as a fundraise actually runs: know your practice → get documents
// in → draft → negotiate → paper it → live with what you promised
const TABS = [
  { key: 'ontology', label: 'Overview' },
  { key: 'intake', label: 'Documents' },
  { key: 'drafting', label: 'Drafting' },
  { key: 'changes', label: 'Changes' },
  { key: 'comments', label: 'Comments' },
  { key: 'side-letters', label: 'Side Letters' },
  { key: 'mfn', label: 'MFN' },
  { key: 'obligations', label: 'Obligations' },
  { key: 'deadlines', label: 'Deadlines' },
] as const;

/** Segmented control with a sliding active pill. */
function SegmentedNav({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = () => {
    const el = btnRefs.current[active];
    // offsetWidth is 0 while the nav is display:none (mobile) — skip until visible
    if (el && el.offsetWidth > 0) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
  };

  useLayoutEffect(measure, [active]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <nav className="seg-track" aria-label="Sections">
      {indicator && <span className="seg-indicator" style={{ left: indicator.left, width: indicator.width }} />}
      {TABS.map((t) => (
        <button
          key={t.key}
          ref={(el) => {
            btnRefs.current[t.key] = el;
          }}
          onClick={() => onSelect(t.key)}
          data-active={active === t.key}
          className="seg-btn"
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const [tab, setTab] = useState<string>('ontology');
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [intro, setIntro] = useState(shouldPlayIntro);
  const [scopeFundId, setScopeFundId] = useState<string | undefined>(undefined);
  const [elevated, setElevated] = useState(false);

  useEffect(() => {
    const onScroll = () => setElevated(window.scrollY > 6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="app-bg min-h-screen overflow-x-hidden">
      {intro && <Intro onDone={() => setIntro(false)} />}
      <header className={`glass hairline-b sticky top-0 z-20 transition-shadow duration-300 ${elevated ? 'header-elevated' : ''}`}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-6 py-3">
          <div className="shrink-0 font-display text-2xl tracking-[0.25em] text-bone">
            FORGE<span className="text-ember">.</span>
          </div>
          <div className="hidden min-w-0 flex-1 md:block">
            <SegmentedNav active={tab} onSelect={setTab} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2.5">
            <WorkspaceSwitcher />
            <span className="hidden lg:inline-flex">
              <StatusBadge />
            </span>
            <button onClick={() => setPrivacyOpen(true)} className="btn-ghost whitespace-nowrap">
              <span className="text-ember">●</span>
              <span className="hidden lg:inline"> What left your machine</span>
              <span className="lg:hidden"> Privacy</span>
            </button>
          </div>
        </div>
        {/* mobile tabs */}
        <nav className="flex gap-1 overflow-x-auto px-4 pb-3 md:hidden" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all ${
                tab === t.key ? 'bg-surface text-bone shadow-sm' : 'text-fog'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <EngineKeyBanner />

      <main key={tab} className="animate-fade-up mx-auto max-w-6xl px-6 py-12">
        {tab === 'ontology' && <Ontology onNavigate={setTab} />}
        {tab === 'intake' && (
          <Intake
            onUseMatter={(fundId) => {
              setScopeFundId(fundId);
              setTab('obligations');
            }}
          />
        )}
        {tab === 'drafting' && <Drafting />}
        {tab === 'changes' && <Changes />}
        {tab === 'comments' && <Comments />}
        {tab === 'side-letters' && <SideLetters />}
        {tab === 'obligations' && <Obligations scopeFundId={scopeFundId} />}
        {tab === 'deadlines' && <Deadlines />}
        {tab === 'mfn' && <Mfn />}
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10 pt-6 text-xs leading-relaxed text-fog/70">
        Forge — a fund formation engine. Fictional client: Vulcan Industrial Partners. Not legal advice; a homage built for fun.
      </footer>

      {privacyOpen && <PrivacyPanel onClose={() => setPrivacyOpen(false)} />}
    </div>
  );
}
