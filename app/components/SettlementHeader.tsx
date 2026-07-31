'use client';

import type { LucideIcon } from 'lucide-react';
import { RefreshCw } from 'lucide-react';
import ProductSwitchTabs from './ProductSwitchTabs';
import ThemeToggle from './ThemeToggle';

type SettlementHeaderProps = {
  icon: LucideIcon;
  title: string;
  isRefreshing: boolean;
  onRefresh: () => void;
};

// Settlement-only replacement for the shared PageHeader's floating pill
// (sticky top-4, mx-4/mx-8, rounded-xl, translucent backdrop-blur) — this is
// a flush, edge-to-edge, solid-bg header per the redesign spec ("Linear/
// Stripe/GitHub dashboard" feel, no floating margins/rounded container).
// PageHeader itself is untouched; the other ~12 pages that still use it are
// unaffected, since this is a separate component, not a PageHeader variant.
//
// Owns no bottom border/shadow of its own — SettlementSummary (the KPI row
// directly below) owns the header REGION's true bottom edge, so title +
// switcher + KPI read as one continuous block instead of two stacked boxes
// with a seam between them.
export default function SettlementHeader({ icon: Icon, title, isRefreshing, onRefresh }: SettlementHeaderProps) {
  return (
    <div className="sticky top-0 z-[60] w-full bg-white dark:bg-[#1c1c1e]">
      {/* grid grid-cols-3 (not flex justify-between) so the switcher can sit
          truly centered in the row regardless of how wide the title/right
          clusters are — a flex-justify-between placement would center it
          relative to the leftover space between those two, not the row. */}
      <div className="grid min-h-[52px] grid-cols-3 items-center px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Same indigo regardless of active product (was --product-accent,
              flipping indigo/teal per product) — kept as one consistent
              color across Cashout and Send Money per explicit instruction. */}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#4f46e5] text-white">
            <Icon size={15} />
          </div>
          <h1 className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
            {title}
          </h1>
        </div>

        <div className="flex justify-center">
          <ProductSwitchTabs variant="segmented" />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3">
          {/* No "Last Updated" timestamp per explicit request — the Live
              dot is the only status indicator now. */}
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
            {/* animate-pulse is Tailwind's built-in opacity-only pulse (1 ->
                .5 -> 1, 2s infinite) — exactly the "subtle, opacity only, no
                scaling" spec, so no custom keyframes needed. */}
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh"
            title="Refresh"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/60 text-indigo-600 transition-colors hover:bg-muted dark:text-indigo-400"
          >
            <RefreshCw size={14} strokeWidth={1.75} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
