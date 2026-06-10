import { useEffect, useState } from 'react';

/**
 * The wooden wall. Two carved oak doors hold for a beat, then slide apart
 * to reveal the engine — a homage to a certain conference stage. Click to
 * skip; reduced-motion users go straight in; plays once per session.
 */

const HOLD_MS = 1700;
const OPEN_MS = 2000;

function introParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('intro');
}

export function shouldPlayIntro(): boolean {
  if (typeof window === 'undefined') return false;
  if (introParam()) return true; // ?intro=1 replays, ?intro=hold freezes
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return sessionStorage.getItem('forge-intro-seen') !== '1';
}

/** One full-viewport wall face; `side` selects which half a door shows. */
function WallFace({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      className="wood-wall absolute top-0 h-full w-[100vw]"
      style={{ left: side === 'left' ? 0 : '-50vw' }}
    >
      <div className="intro-frame absolute inset-5" />
      {/* carved ring marks flanking the plaque, as on the stage */}
      <div className="wood-ring intro-mark absolute left-[11vw] top-1/2 hidden h-11 w-11 -translate-y-1/2 rounded-full md:block" />
      <div className="wood-ring intro-mark absolute right-[11vw] top-1/2 hidden h-11 w-11 -translate-y-1/2 rounded-full md:block" />
      {/* the carved nameplate, spanning the seam */}
      <div className="intro-mark absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="wood-plaque px-16 py-7 md:px-28 md:py-9">
          <span className="wood-engraved whitespace-nowrap font-display text-6xl font-semibold tracking-[0.34em] md:text-8xl">
            FORGE
          </span>
        </div>
      </div>
    </div>
  );
}

export function Intro({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    sessionStorage.setItem('forge-intro-seen', '1');
    if (introParam() === 'hold') return; // frozen for inspection; click to open
    const t1 = setTimeout(() => setOpen(true), HOLD_MS);
    return () => clearTimeout(t1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t2 = setTimeout(() => {
      setGone(true);
      onDone();
    }, OPEN_MS);
    return () => clearTimeout(t2);
  }, [open, onDone]);

  if (gone) return null;

  return (
    <div
      className="fixed inset-0 z-50 cursor-pointer overflow-hidden"
      onClick={() => setOpen(true)}
      role="presentation"
      aria-hidden="true"
    >
      {/* dim veil over the app while the doors are closed */}
      <div className={`intro-veil absolute inset-0 bg-coal ${open ? 'opacity-0' : 'opacity-100'}`} />

      {/* left door */}
      <div
        className="intro-door absolute inset-y-0 left-0 w-1/2 overflow-hidden shadow-[8px_0_40px_rgba(0,0,0,0.6)]"
        style={{ transform: open ? 'translateX(-101%)' : 'translateX(0)' }}
      >
        <WallFace side="left" />
      </div>

      {/* right door */}
      <div
        className="intro-door absolute inset-y-0 right-0 w-1/2 overflow-hidden shadow-[-8px_0_40px_rgba(0,0,0,0.6)]"
        style={{ transform: open ? 'translateX(101%)' : 'translateX(0)' }}
      >
        <WallFace side="right" />
      </div>
    </div>
  );
}
