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

// Re-triggers a 200ms opacity fade (0 -> 1) whenever `value` changes — e.g.
// after Refresh resolves with new numbers. Not a counting animation, just a
// fade; resets to invisible synchronously on value change, then flips to
// visible on the next frame so the CSS transition actually has something to
// animate from.
function FadeValue({ value, className }: { value: string; className: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <div className={`${className} transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}>
      {value}
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
export default function SettlementSummary({ items, isScrolled }: { items: SettlementKpiItem[]; isScrolled: boolean }) {
  return (
    <div
      className={`flex h-[72px] w-full flex-wrap items-stretch gap-x-8 border-t border-border bg-white px-2 transition-shadow duration-150 ease-out dark:bg-[#1c1c1e] md:px-4 ${
        isScrolled ? TABLE_STICKY_HEADER_SHADOW_CLASS : ''
      }`}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-[150px] flex-1 cursor-default flex-col justify-center gap-0.5 rounded-lg px-4 transition-colors duration-200 ease-out hover:bg-muted/30"
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
      ))}
    </div>
  );
}
