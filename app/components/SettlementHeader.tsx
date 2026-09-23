'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Moon, Sun } from 'lucide-react';
import { usePathname } from 'next/navigation';
import ProductSwitchTabs from './ProductSwitchTabs';
import AccountMenu from './AccountMenu';
import { useTheme } from './ThemeProvider';
import { isProductSwitchRoute } from '../lib/productRoutes';

type SettlementHeaderProps = {
  // Kept in the prop type so every existing call site (which all still pass
  // an icon) keeps compiling — no longer rendered, see below.
  icon: LucideIcon;
  title: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  // Optional page-specific content rendered before Refresh (e.g. Balance's
  // own "Updated {time}" Bulk Import Balance Limit indicator) — undefined
  // renders nothing, so every other page using this shared header is
  // unaffected.
  extra?: ReactNode;
  // Optional page-specific content rendered on the LEFT, right after the
  // title (e.g. Opening/Balance's own "Last update {Opening upload date}"
  // indicator) — per explicit instruction, distinct from `extra` above
  // (which stays on the right, next to Refresh) since this one belongs on
  // the same side as the title instead. undefined renders nothing, so
  // every other page using this shared header is unaffected.
  titleExtra?: ReactNode;
};

// Settlement-only replacement for the shared PageHeader's floating pill
// (sticky top-4, mx-4/mx-8, rounded-xl, translucent backdrop-blur).
// PageHeader itself is untouched; the other ~12 pages that still use it are
// unaffected, since this is a separate component, not a PageHeader variant.
//
// Restyled to match Daily Txn Entry's own header (app/daily-txn-entry/
// page.tsx's PageHeader `containerless` usage) universally, across every
// page this component appears on, per explicit instruction: no icon badge,
// larger plain title, title+Refresh+AccountMenu in the top row only — the
// Cashout/Send Money switcher moves to its own row below, left-aligned,
// exactly like that page's Operations/Report/CashGo tabs sit below its own
// title (pill style copied from those same tabs — see ProductSwitchTabs'
// 'pills' variant). No "Last Updated" timestamp, and no "Live" indicator
// either — dropped per explicit instruction to match that reference header
// exactly (neither row carries a status badge there).
//
// Two more things pulled from that same reference, per explicit follow-up:
// (1) no distinct fill — that page's title sits directly on the page's own
// background (ContainerlessHeader's `background: var(--ink-0)`), not a
// separate solid-white bar; `bg-white` here was visibly different from
// every page's own light-mode bg (`#f4f6fb`), which is exactly why this
// read as a distinct bar. Light mode uses `bg-background` (matches every
// consuming page's own root exactly); dark mode is an explicit
// `dark:bg-[#0A0C11]` override, NOT the app's generic dark `--background`
// (`#020617`) — per later explicit instruction, these ~13 pages (this
// header plus DataTable/SettlementSummary, its two other shared pieces)
// adopt Daily Txn Entry's own dark palette specifically (page `#0A0C11`,
// card `#12151D`, table header strip `#0E1119`, border `#262B38`/
// `#1A1E29`) rather than the rest of the app's normal dark mode — every
// page OUTSIDE this group (tickets, staff, login, dashboard, etc.) keeps
// the app's standard dark mode untouched. (2) same content column as the
// page body — padding lives on the OUTER full-width sticky div
// (px-4 md:px-[28px], the exact classes Daily Txn Entry's own <main> uses),
// with a bare `mx-auto max-w-[1400px]` div inside it — matching that page's
// own padding-then-maxwidth order exactly (getting this backwards, e.g.
// padding on the inner maxw'd div instead, changes the mx-auto centering
// math and throws off the final left edge by a few pixels — confirmed via
// getBoundingClientRect() diffing against that page's own header). The
// border-b lives on this inner div too, so it only spans the 1400px content
// column like that page's own PageHeader border — not the full viewport
// width, which is what made it look "over-extended" per explicit bug
// report.
//
// The switcher row only renders on routes that actually have a Send Money
// counterpart (same `isProductSwitchRoute` check ProductSwitchTabs uses
// internally to render nothing) — otherwise every non-switch page (there
// are several) would grow an empty bordered strip under its title for no
// reason.
export default function SettlementHeader({ title, isRefreshing, onRefresh, extra, titleExtra }: SettlementHeaderProps) {
  const pathname = usePathname();
  const showSwitcher = isProductSwitchRoute(pathname);
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="sticky top-0 z-[60] w-full bg-background px-4 dark:bg-[#0A0C11] md:px-[28px]">
      {/* pt-[30px]/pb-[14px] matches Daily Txn Entry's own total top/bottom
          spacing exactly: that page's title sits 30px down (its shared
          content wrapper's own pt-4/16px + PageHeader's own pt-[14px]) and
          14px above its border-b (PageHeader's own pb-[14px]) — confirmed
          via getBoundingClientRect() diffing, not eyeballed. Was py-3 (12px
          both sides), which sat flush near the very top per explicit bug
          report. */}
      <div className="mx-auto flex min-h-[56px] max-w-[1400px] items-center justify-between gap-3 border-b border-border pb-[14px] pt-[30px]">
        {/* text-[22px] matches Daily Txn Entry's own title exactly (that
            page's PageHeader `containerless` usage — see
            ContainerlessHeader in app/components/PageHeader.tsx) — pulled
            from its actual class, not eyeballed. */}
        <h1 className="min-w-0 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {/* titleExtra renders here (next to the title) only when there's no
            switcher row below to carry it instead — see that row further
            down, where it actually lives for every page that has one. */}
        {!showSwitcher && titleExtra}

        {/* Refresh + theme toggle + avatar — pixel-identical to Daily Txn
            Entry's own header actions (app/daily-txn-entry/page.tsx's
            PageHeader `actions`), copied verbatim per explicit instruction:
            same 22x22 button chrome/colors, same hand-drawn refresh SVG
            (not a lucide icon — that page keeps it pixel-identical to
            Operations Overview's own Refresh button on purpose), same
            11px Sun/Moon size, same `compact` AccountMenu variant. */}
        <div className="flex shrink-0 items-center gap-3">
          {extra}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh"
            title="Refresh"
            className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] disabled:opacity-50 dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
          >
            <svg
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="none"
              className={isRefreshing ? 'animate-spin' : ''}
              style={{ color: isRefreshing ? 'var(--ui-accent)' : undefined }}
            >
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle light and dark mode"
            title="Toggle light and dark mode"
            className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
          >
            {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
          </button>
          <AccountMenu compact />
        </div>
      </div>

      {/* No border on this row at all — matches Daily Txn Entry's own tabs
          row exactly (app/daily-txn-entry/page.tsx's `<div className="mb-4
          flex items-center gap-2">`), which sits below PageHeader's single
          border-b with no divider of its own. Two borders this close
          together (this row's own border-t stacked right under the title
          row's border-b) read as one doubled/stray line, per explicit
          bug report.

          py-4 (16px, both sides) is a deliberate, symmetric value per
          explicit follow-up — the space from the title row's border-b down
          to the pills must equal the space from the pills down to
          whatever's next. Consuming pages (Top Up's own `<main>`) drop
          their own extra top padding in favor of this row's pb-4 doing that
          job, so the two sides land equal instead of the pills sitting
          closer to the line above them than to the content below. */}
      {showSwitcher && (
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-2 py-4">
          <ProductSwitchTabs variant="pills" />
          {titleExtra}
        </div>
      )}
    </div>
  );
}
