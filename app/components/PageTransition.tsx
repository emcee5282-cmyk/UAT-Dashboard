'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  // Once the enter transition finishes, the transform is dropped entirely
  // rather than left at 'translateY(0)'. A "no-op" transform value still
  // establishes a new containing block for descendants (anything other
  // than the literal keyword `none` does, per spec) — which silently
  // breaks position:sticky for any descendant, on every page, all the
  // time (not just mid-transition). Found via the Dashboard's sticky
  // header reporting a correct getBoundingClientRect() but visually
  // scrolling away with the page instead of freezing at the viewport top.
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    // Same app-wide pattern flagged everywhere this file's set-state-on-
    // pathname-change shape appears (see e.g. app/page.tsx's fetchData
    // effect) — not something specific to this component.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(false);
    setSettled(false);
    const t = setTimeout(() => setVisible(true), 16);
    // `settled` used to flip only via onTransitionEnd below, which isn't
    // reliable enough to gate something as load-bearing as removing the
    // containing-block-creating transform: a backgrounded tab, a second
    // pathname change interrupting this one before it finishes, or
    // prefers-reduced-motion can all skip the transitionend event entirely,
    // leaving `settled` stuck false — and the transform permanently
    // applied — for the rest of that page's life. A fixed timeout matching
    // the CSS transition duration (300ms, see the className below) is the
    // authoritative fallback; onTransitionEnd can still fire it early, but
    // this is what guarantees it always eventually fires.
    const t2 = setTimeout(() => setSettled(true), 16 + 320);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [pathname]);

  return (
    <div
      className="transition-all duration-300 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: settled ? undefined : visible ? 'translateY(0)' : 'translateY(6px)',
        minHeight: '100%',
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'transform' && visible) setSettled(true);
      }}
    >
      {children}
    </div>
  );
}
