import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, type Fund } from './api.js';
import { FundContext } from './fund-context.js';
import { Helper } from './Helper.js';
import { Intro, shouldPlayIntro } from './Intro.js';
import { PrivacyButton, PrivacyPanel, WorkspaceSwitcher, EngineKeyBanner } from './components.js';
import { Ontology } from './pages/Ontology.js';
import { Intake } from './pages/Intake.js';
import { Drafting } from './pages/Drafting.js';
import { Changes } from './pages/Changes.js';
import { Comments } from './pages/Comments.js';
import { SideLetters } from './pages/SideLetters.js';
import { Obligations } from './pages/Obligations.js';
import { Deadlines } from './pages/Deadlines.js';
import { Mfn } from './pages/Mfn.js';

// ordered as a fundraise actually runs: know your practice and your files,
// then raise (draft, negotiate, paper it), then live with what you promised
const TABS = [
  { key: 'ontology', label: 'Overview' },
  { key: 'intake', label: 'Documents' },
  { key: 'drafting', label: 'Drafting' },
  { key: 'changes', label: 'Changes' },
  { key: 'comments', label: 'Comments' },
  { key: 'side-letters', label: 'Side Letters' },
  { key: 'obligations', label: 'Obligations' },
  { key: 'deadlines', label: 'Deadlines' },
  { key: 'mfn', label: 'MFN' },
] as const;

// thin dividers after these tabs teach the lifecycle at a glance
const GROUP_AFTER = new Set(['intake', 'side-letters']);

/** Segmented control with a sliding active pill. */
function SegmentedNav({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const trackRef = useRef<HTMLElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const updateFades = () => {
    const t = trackRef.current;
    if (!t) return;
    const left = t.scrollLeft > 4;
    const right = t.scrollLeft + t.clientWidth < t.scrollWidth - 4;
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
  };

  const measure = () => {
    const el = btnRefs.current[active];
    // offsetWidth is 0 while the nav is display:none (mobile): skip until visible
    if (el && el.offsetWidth > 0) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    updateFades();
  };

  // when the track scrolls, the selected tab must never sit hidden in the dark
  const reveal = () => {
    const t = trackRef.current;
    const el = btnRefs.current[active];
    if (!t || !el || el.offsetWidth === 0) return;
    const pad = 32;
    // instant, not smooth: the tab switch remounts the page content in the
    // same frame, which cancels an in-flight smooth scroll. The sliding
    // indicator carries the motion.
    if (el.offsetLeft < t.scrollLeft + pad) {
      t.scrollTo({ left: Math.max(0, el.offsetLeft - pad) });
    } else if (el.offsetLeft + el.offsetWidth > t.scrollLeft + t.clientWidth - pad) {
      t.scrollTo({ left: el.offsetLeft + el.offsetWidth - t.clientWidth + pad });
    }
  };

  useLayoutEffect(() => {
    measure();
    // deferred past the same frame's content remount (a timeout, not rAF:
    // rAF never fires in hidden tabs and the reveal must not depend on it)
    const id = window.setTimeout(() => {
      reveal();
      updateFades();
    }, 30);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure).catch(() => {});
    // the track can change size without a window resize (header wrap, zoom)
    const ro = trackRef.current ? new ResizeObserver(() => measure()) : null;
    if (ro && trackRef.current) ro.observe(trackRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div className="relative mx-auto w-max min-w-0 max-w-full">
      <span aria-hidden className={`seg-fade seg-fade-l ${fade.left ? 'is-on' : ''}`} />
      <span aria-hidden className={`seg-fade seg-fade-r ${fade.right ? 'is-on' : ''}`} />
      <nav ref={(el) => { trackRef.current = el; }} onScroll={updateFades} className="seg-track" aria-label="Sections">
      {indicator && <span className="seg-indicator" style={{ left: indicator.left, width: indicator.width }} />}
      {TABS.map((t) => (
        <Fragment key={t.key}>
          <button
            ref={(el) => {
              btnRefs.current[t.key] = el;
            }}
            onClick={() => onSelect(t.key)}
            data-active={active === t.key}
            className="seg-btn"
          >
            {t.label}
          </button>
          {GROUP_AFTER.has(t.key) && <span className="seg-divider" aria-hidden />}
        </Fragment>
      ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<string>('ontology');
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [intro, setIntro] = useState(shouldPlayIntro);
  const [elevated, setElevated] = useState(false);

  // the one fund every page acts on, picked once in the header (or by
  // clicking a fund card on Overview)
  const [funds, setFunds] = useState<Fund[]>([]);
  const [fundId, setFundId] = useState('');
  const refreshFunds = async (): Promise<void> => {
    try {
      const all = await get<Fund[]>('/funds');
      setFunds(all);
      setFundId((cur) => (cur && all.some((f) => f.id === cur) ? cur : (all.find((f) => f.id === 'fund-3') ?? all[0])?.id ?? ''));
    } catch {
      /* server not up yet; the health banner covers it */
    }
  };
  useEffect(() => {
    void refreshFunds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onScroll = () => setElevated(window.scrollY > 6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <FundContext.Provider value={{ fundId, setFundId, funds, refreshFunds }}>
    <div className="app-bg min-h-screen overflow-x-hidden">
      {intro && <Intro onDone={() => setIntro(false)} />}
      <header className={`glass hairline-b sticky top-0 z-20 transition-shadow duration-300 ${elevated ? 'header-elevated' : ''}`}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-2 pt-3">
          <div className="shrink-0 font-display text-2xl tracking-[0.25em] text-bone">FORGE</div>
          <div className="ml-auto flex shrink-0 items-center gap-2.5">
            {funds.length > 0 && (
              <select
                value={fundId}
                onChange={(e) => setFundId(e.target.value)}
                className="field max-w-72 py-2 text-[13px]"
                title="The fund every page acts on. Pick it once; Drafting, Comments, Side Letters and the rest all follow."
                aria-label="Active fund"
              >
                {funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name.replace(', L.P.', '')}
                  </option>
                ))}
              </select>
            )}
            <WorkspaceSwitcher />
            <PrivacyButton onClick={() => setPrivacyOpen(true)} />
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 sm:px-6">
          <SegmentedNav active={tab} onSelect={setTab} />
        </div>
      </header>
      <EngineKeyBanner />

      <main key={tab} className="animate-fade-up mx-auto max-w-6xl px-6 py-12">
        {tab === 'ontology' && <Ontology onNavigate={setTab} />}
        {tab === 'intake' && (
          <Intake
            onUseMatter={(id) => {
              setFundId(id);
              setTab('obligations');
            }}
          />
        )}
        {tab === 'drafting' && <Drafting />}
        {tab === 'changes' && <Changes />}
        {tab === 'comments' && <Comments />}
        {tab === 'side-letters' && <SideLetters />}
        {tab === 'obligations' && <Obligations />}
        {tab === 'deadlines' && <Deadlines />}
        {tab === 'mfn' && <Mfn />}
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10 pt-6 text-xs leading-relaxed text-fog/70">
        Forge, a fund formation engine. Fictional client: Vulcan Industrial Partners. Not legal advice; a homage built for fun.
      </footer>

      <Helper onNavigate={setTab} />

      {privacyOpen && <PrivacyPanel onClose={() => setPrivacyOpen(false)} />}
    </div>
    </FundContext.Provider>
  );
}
