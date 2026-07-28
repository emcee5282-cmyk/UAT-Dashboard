'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// Outer shell — border, radius, overflow, flex-col. Owns none of the
// content inside; Toolbar / DataTable.ScrollArea / TableFooter are all
// composed by the consumer as plain children. `className` is appended
// (not replaced) — for spacing needs only (e.g. a margin relative to
// something else on the page above it), since it doesn't conflict with
// the fixed border/radius/bg the way Toolbar's height/padding would.
export default function DataTable({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex-1 flex flex-col min-h-0 bg-white rounded-[12px] border border-[#E5E7EB] overflow-hidden dark:bg-[#2a2a2d] dark:border-[#3a3a3d] ${className}`}>
      {children}
    </div>
  );
}

// Scrollable table body — tracks its own scroll position and exposes it to
// children via a render-prop (isScrolled), so a sticky header inside can
// pick up a shadow once real content is scrolling underneath it, without
// this component knowing anything about what "header" or "shadow" mean.
// `.dt-scroll` (globals.css) supplies the thin custom scrollbar; `className`
// lets a page add its own responsive visibility (e.g. Settlement hides this
// entirely below `sm:` in favor of a mobile card list).
//
// `onScrolledChange` is an optional escape hatch for a PAGE-level sticky
// element outside this component's own children (e.g. Settlement's sticky
// header + KPI row, which sit above <main> and can't receive the render-prop
// directly) — this is the only scroll listener anywhere on those pages, so
// lifting its result via callback is the only way an ancestor can ever know
// scrolling happened. Fired from the same effect as the existing
// setIsScrolled call (not from the render-prop itself) so a parent updating
// its own state during this component's render never trips React's
// cross-component setState-during-render warning. Optional and unused by
// every other consumer — purely additive.
function DataTableScrollArea({
  children,
  className = '',
  onScrolledChange,
}: {
  children: (isScrolled: boolean) => ReactNode;
  className?: string;
  onScrolledChange?: (isScrolled: boolean) => void;
}) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [atScrollStart, setAtScrollStart] = useState(true);
  const [atScrollEnd, setAtScrollEnd] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleScroll = () => {
      const next = el.scrollTop > 0;
      setIsScrolled(next);
      onScrolledChange?.(next);
      setAtScrollStart(el.scrollLeft <= 1);
      setAtScrollEnd(el.scrollLeft >= el.scrollWidth - el.offsetWidth - 1);
    };
    handleScroll();
    el.addEventListener('scroll', handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [onScrolledChange]);

  return (
    <div className={`relative flex-1 min-h-0 ${className}`}>
      <div ref={ref} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
        <div className="w-full text-sm" role="table">
          {children(isScrolled)}
        </div>
      </div>
      {!atScrollStart && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-[55] w-6 bg-gradient-to-r from-white to-transparent dark:from-[#2a2a2d]" />
      )}
      {!atScrollEnd && (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-[55] w-6 bg-gradient-to-l from-white to-transparent dark:from-[#2a2a2d]" />
      )}
    </div>
  );
}

// Sticky header chrome — background, border, and the scroll-triggered
// shadow only. Deliberately doesn't know about columns, sorting, or
// labels — that's whatever the caller renders as children (typically a
// role="row" of role="columnheader" cells with their own sort logic,
// which stays page-specific rather than living in this generic system).
function DataTableStickyHeader({ isScrolled, children }: { isScrolled: boolean; children: ReactNode }) {
  return (
    <div
      role="rowgroup"
      className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${
        isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
      }`}
    >
      {children}
    </div>
  );
}

DataTable.ScrollArea = DataTableScrollArea;
DataTable.StickyHeader = DataTableStickyHeader;
