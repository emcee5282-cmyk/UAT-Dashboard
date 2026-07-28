'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { TABLE_STICKY_HEADER_SHADOW_CLASS } from '../design-system/shadows';

// Label + value only — no comparison/trend/helper text of any kind, per
// explicit "each KPI should only contain: small label, large value, nothing
// underneath" instruction. Each page still computes real today/yesterday
// stats (see kpiStats in app/stlm and app/sendmoney/settlement) since
// Yesterday's Total Count/Amount are themselves 2 of the 4 required
// metrics — only the derived "vs yesterday" percentage line is gone.
export type SettlementKpiItem = {
  icon: LucideIcon;
  label: string;
  value: string;
};

// Re-triggers a 200ms opacity+translateY fade (matching Stripe/Linear-style
// "settle in" motion) whenever `value` changes — e.g. after Refresh resolves
// with new numbers, or the very first time this mounts (replacing the
// skeleton). Starts INVISIBLE (not visible) so that first-mount case is a
// single clean entrance rather than a visible->hidden->visible blink — the
// effect below always fires once after mount regardless of whether `value`
// "changed" from anything, so starting at visible=true would otherwise
// paint at full opacity for one frame, then immediately animate out and
// back in.
function FadeValue({ value, className }: { value: string; className: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <div
      className={`${className} transition-[opacity,transform] duration-200 ease-out ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[5px]'
      }`}
    >
      {value}
    </div>
  );
}

// Skeleton width scales with the real label's own character count (per
// explicit "same width as expected content" requirement) rather than a
// fixed guess — every consumer's labels ("Today's Total Count" vs "Total
// Opening Balance" etc.) are different lengths, and this keeps the
// skeleton's proportions honest for all of them without hardcoding per-page
// widths here.
function KpiSkeletonTile({ labelLength }: { labelLength: number }) {
  const labelWidth = Math.max(60, Math.min(labelLength * 6.2, 150));
  return (
    <div className="flex min-w-[150px] flex-1 flex-col justify-center gap-0.5 rounded-lg px-4">
      <div className="flex items-center text-[11px]">
        <div className="dt-skeleton h-[11px] rounded-md" style={{ width: labelWidth }} />
      </div>
      <div className="dt-skeleton mt-1 h-[22px] w-24 rounded-md" />
    </div>
  );
}

// Compact KPI summary strip for Settlement (Cashout + Send Money) — a plain
// divided row, NOT the app's existing bigger bordered "KPI card" pattern
// (Agent Balance etc.) per the redesign spec's explicit "not giant colorful
// cards" instruction. Values are computed from real sheet data by each page
// (see each page's own kpiStats/kpiItems) — see fetchData in app/stlm and
// app/sendmoney/settlement for the actual today-vs-yesterday computation.
//
// Owns the scroll-triggered shadow (SettlementHeader above has none of its
// own). Not itself `position: sticky` — it's a plain flex-column sibling of
// SettlementHeader, both non-scrolling by construction (the page root is
// `h-screen overflow-hidden`; only DataTable.ScrollArea below ever scrolls),
// so it stays visible without needing its own sticky/top offset — which
// would otherwise have to guess SettlementHeader's exact rendered height.
//
// Only a TOP separator, full-width edge-to-edge (a real border-t, not an
// inset <div> line) — it's the boundary between the header/switcher row
// above and the KPI numbers, per explicit direction to keep this one and
// make it span the whole width, not inset. No bottom separator at all —
// the KPI strip flows straight into the toolbar/table below with just
// whitespace, no line, per explicit direction to remove it entirely.
//
// Background is the page's own bg (#f4f6fb, matches --background's light
// value — see app/globals.css) rather than solid white like
// SettlementHeader above it. bg-white here made the header+KPI region read
// as one fused white slab against the page's pale background, instead of
// the KPI strip visually floating the same way the Toolbar/table card
// below already does. Dark mode is untouched (#1c1c1e) — the page's own
// dark background already uses this same hardcoded value elsewhere (see
// each page's root div), so there's no equivalent seam to fix there.
//
// Loading behavior — three distinct states, not just "loading vs not":
//   1. First-ever load (`loading && !hasLoadedOnce`): every tile renders as
//      a skeleton (label bar + value bar) instead of `items`, since the
//      real numbers haven't arrived yet and showing "0"/"−" placeholders
//      would read as real (if wrong) data rather than a loading state.
//   2. Refresh (`loading && hasLoadedOnce`): the PREVIOUS items stay fully
//      rendered (each page's own kpiStats naturally isn't cleared until the
//      new fetch resolves, so `items` already holds the stale-but-real
//      values for free) — just dimmed slightly so the row still reads as
//      "working," without blanking back to skeletons or flashing empty.
//   3. Loaded (`!loading`): full opacity, each value's own FadeValue plays
//      its crossfade — covers both "skeleton just replaced by first real
//      values" and "refresh replaced old values with new ones," since both
//      are just a `value` change from FadeValue's perspective once
//      `hasLoadedOnce` flips true and the real tiles mount.
export default function SettlementSummary({ items, isScrolled, loading }: { items: SettlementKpiItem[]; isScrolled: boolean; loading: boolean }) {
  const [hasLoadedOnce, setHasLoadedOnce] = useState(!loading);

  useEffect(() => {
    if (!loading) setHasLoadedOnce(true);
  }, [loading]);

  const showSkeleton = loading && !hasLoadedOnce;
  const isRefreshing = loading && hasLoadedOnce;

  return (
    <div
      className={`flex h-[72px] w-full flex-wrap items-stretch gap-x-8 border-t border-border bg-[#f4f6fb] px-2 transition-shadow duration-150 ease-out dark:bg-[#1c1c1e] md:px-4 ${
        isScrolled ? TABLE_STICKY_HEADER_SHADOW_CLASS : ''
      }`}
    >
      {showSkeleton ? (
        items.map((item) => <KpiSkeletonTile key={item.label} labelLength={item.label.length} />)
      ) : (
        items.map((item) => (
          <div
            key={item.label}
            className={`flex min-w-[150px] flex-1 cursor-default flex-col justify-center gap-0.5 rounded-lg px-4 transition-[opacity,background-color] duration-200 ease-out hover:bg-muted/30 ${
              isRefreshing ? 'opacity-75' : 'opacity-100'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <item.icon size={13} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </div>
            {/* The number is the visual anchor — 26px bold, leading-none (not
                leading-tight) so the tight line-height doesn't leave any of
                the value's own line-height padding around it. Nothing renders
                below it. */}
            <FadeValue value={item.value} className="text-[26px] font-bold leading-none text-foreground" />
          </div>
        ))
      )}
    </div>
  );
}
