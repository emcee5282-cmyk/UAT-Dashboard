'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import * as XLSX from 'xlsx';
import {
  Wallet, Building2, Download, ChevronUp, ChevronDown, Sun, Moon, Send,
} from 'lucide-react';
import PageHeader from './components/PageHeader';
import AccountMenu from './components/AccountMenu';
import ConnectionErrorState from './components/ConnectionErrorState';
import WaveTrendChart, { type WaveTrendDataPoint, type WaveTrendSeriesDef } from './components/WaveTrendChart';
import Toast, { type ToastState } from './components/Toast';
import { useTheme } from './components/ThemeProvider';
import { classifyFetchError, type ClassifiedError } from './lib/errors';

/* =============================================================================
   Production Dashboard ("/") — full replacement per the approved plan
   (rippling-orbiting-duckling.md): ports public/dashboard-demo.html's design
   into React/Tailwind on this project's Design System v2 tokens, wired to the
   real app/api/dashboard/route.ts response (no client-side CSV parsing —
   that route already does every computation server-side). Telegram capture
   (deferred when this page first shipped) is now wired — same
   /api/telegram/screenshot + `data-telegram-capture` selector pattern
   already proven on app/shadcn-demo/balance-overview/page.tsx, applied to
   this page's own Today's Insights + Brand Balance sections.
   ============================================================================= */

// ---------------------------------------------------------------------------
// API response types — mirror app/api/dashboard/route.ts's exact JSON shape.
// `chart`/`chart30` are typed directly as WaveTrendDataPoint (not a stricter
// shape re-declared here) so they can be handed straight to WaveTrendChart
// with no assignability friction against its own `{date:string} &
// Record<string, number>` prop type.
// ---------------------------------------------------------------------------

type ApiWalletLedgerRow = {
  name: string;
  dp: number;
  wd: number;
  mid: number | null;
  settlement: number | null;
  actual: number;
  running: number;
  change: number;
};

type ApiOverviewWallet = { name: string; total: number; change: number; actual: number };
type ApiTodayWallet = { name: string; value: number; quota?: number };

type ApiOverview = {
  opening: number;
  deposit: number;
  withdrawal: number;
  topup: number;
  settlement: number;
  ending: number;
  endingChange: number;
  progressValue: number;
  progressQuota?: number;
  // "Today" in the normal case; the actual stale business day (e.g. "Sep
  // 15") whenever the server's cutoff-widening is active, so the strip
  // never claims a carried-forward figure is from today.
  progressLabel: string;
  todayWallets: ApiTodayWallet[];
  wallets: ApiOverviewWallet[];
  // Balance Limit's own last-upload timestamp (ISO string) — Ending
  // Balance above is the same Company Balance figure the Balance page
  // shows, driven by this same upload. null if Balance Limit has never
  // been uploaded for this product yet.
  lastUpdate: string | null;
};

type ApiProduct = {
  dep: number;
  wd: number;
  actual: number;
  running: number;
  changeVsOpening: number;
  chart: WaveTrendDataPoint[];
  chart30: WaveTrendDataPoint[];
  openingTrend: { date: string; value: number }[];
  wallets: ApiWalletLedgerRow[];
  overview: ApiOverview;
};

type ApiTopPerformer = { wallet: string; gain: number; actualBal: number };
type ApiAgent = { agentName: string; opening: number; runningBalance: number; totalDP: number; balanceInside: number };

type ApiBrandBalance = {
  brand: string;
  topUp: number;
  settlement: number;
  staticOpening: number;
  staticDeposit: number;
  staticWithdrawal: number;
  staticTotal: number;
};

type ApiCashInHand = {
  brand: string;
  sspAg: number;
  sspPs: number;
  ess: number;
  autopay: number;
  autopaySupported: boolean;
  expay: number;
  totalBrandCIH: number;
};

type DashboardData = {
  cashout: ApiProduct;
  sendmoney: ApiProduct;
  topPerformers: { cashout: ApiTopPerformer[]; sendmoney: ApiTopPerformer[] };
  agents: { cashout: ApiAgent[]; sendmoney: ApiAgent[] };
  brandBalance: { cashout: ApiBrandBalance[]; sendmoney: ApiBrandBalance[] };
  cashInHand: { rows: ApiCashInHand[]; total: ApiCashInHand | null };
};

type Product = 'cashout' | 'sendmoney';

// Module-level constants — WaveTrendChart's own internal useEffect depends on
// referential stability of the `series`/`tooltipSeries` props, so these must
// not be recreated as inline literals on every render. The chart LINE itself
// collapses to a single combined "Total" (colored with Bkash's blue for both
// products, per explicit design request); the hover TOOLTIP still breaks the
// day down by wallet, reading the original per-wallet fields withTotal below
// preserves alongside the added `total`.
const CASHOUT_TREND_SERIES: WaveTrendSeriesDef[] = [{ key: 'total', label: 'Total', colorVar: '--bkash' }];
const SENDMONEY_TREND_SERIES: WaveTrendSeriesDef[] = [{ key: 'total', label: 'Total', colorVar: '--bkash' }];
const CASHOUT_WALLET_SERIES: WaveTrendSeriesDef[] = [
  { key: 'bkash', label: 'Bkash', colorVar: '--bkash' },
  { key: 'nagad', label: 'Nagad', colorVar: '--nagad' },
];
const SENDMONEY_WALLET_SERIES: WaveTrendSeriesDef[] = [
  { key: 'nagad', label: 'Nagad', colorVar: '--pos' },
  { key: 'rocket', label: 'Rocket', colorVar: '--nagad' },
  { key: 'upay', label: 'Upay', colorVar: '--upay' },
];

// Adds a `total` field (sum of whatever wallet keys are present) to each
// point alongside its original per-wallet fields — the combined line reads
// `total`; the tooltip's per-wallet breakdown still reads the originals.
function withTotal(points: WaveTrendDataPoint[]): WaveTrendDataPoint[] {
  return points.map(
    (p) =>
      ({
        ...p,
        total: Object.keys(p).reduce((sum, k) => (k === 'date' ? sum : sum + (p[k] || 0)), 0),
      }) as unknown as WaveTrendDataPoint
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Signed, 2-decimal — used wherever a real +/- sign should show through
// naturally (no manual prefix), the "neutral unless negative" convention
// this whole redesign uses instead of the old per-column green/red coloring.
function fmt2(num: number): string {
  return num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Absolute-magnitude, 2-decimal — used where the caller adds its own sign or
// arrow glyph rather than relying on the number's own minus sign.
function fmt(num: number): string {
  return Math.abs(num).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Millions, 2-decimal, absolute magnitude — matches every other "M" value on
// this page (WalletBreakdownTile, TodayHighlight, QuotaRow all use
// `.toFixed(2)`), used for the hero-row (Net Position/Total Deposit/Total
// Withdrawal) ported from dashboard-demo.html's own fmtM().
function fmtM(num: number): string {
  return (Math.abs(num) / 1_000_000).toFixed(2);
}

// Plain unless genuinely negative (rose) — null/undefined renders a muted
// dash. Used for the 5-metric grid and the Wallet Summary ledger's Top
// Up/Bundle & Settlement cells (both already come back `null` from the API
// when zero, not synthesized here).
function neutralDisplay(value: number | null | undefined): { text: string; className: string } {
  if (value === null || value === undefined) {
    return { text: '−', className: 'text-muted-foreground' };
  }
  return { text: fmt2(value), className: value < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground' };
}

// Same as neutralDisplay, but the magnitude only — no "-" sign, red color
// still applies for negatives. Today's Insights' own Opening/Deposit/
// Withdrawal/Top Up/Settlement metric boxes only, not the Wallet Summary
// table's equivalent columns (those keep neutralDisplay's own signed text).
function neutralDisplayRounded(value: number | null | undefined): { text: string; className: string } {
  if (value === null || value === undefined) {
    return { text: '−', className: 'text-muted-foreground' };
  }
  return { text: fmt(value), className: value < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground' };
}

// Zero also renders a muted dash (not "0.00") — used for Running Balance by
// Brand / Cash In Hand, matching this codebase's pre-existing convention for
// those two specific tables (ported verbatim from the old page's own
// cihValueDisplay).
function cihValueDisplay(value: number): { text: string; className: string } {
  const zero = Math.abs(value) < 0.005;
  const negative = value < 0;
  return {
    text: zero ? '−' : `${negative ? '−' : ''}${fmt(value)}`,
    className: zero ? 'text-muted-foreground' : negative ? 'text-[color:var(--dd-neg)]' : 'text-foreground',
  };
}

// Universal pulse (app/globals.css's .dt-skeleton) — every skeleton block
// pulses in sync, no phase offset, per explicit instruction. Callers' own
// `rounded-*`/sizing classes in `className` are meant to win over the bare
// default here (matches the real content's own radius per call site) —
// kept exactly as the existing call sites already rely on.
function SkeletonBlock({ className }: { className: string }) {
  return <div className={`dt-skeleton rounded-md ${className}`} />;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-[10px] mt-[22px] text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{children}</h2>;
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={12} className="text-indigo-600 dark:text-indigo-400" />
  ) : (
    <ChevronDown size={12} className="text-indigo-600 dark:text-indigo-400" />
  );
}

function xlsxTimestampedFilename(prefix: string): string {
  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${datePart}_${timePart}.xlsx`;
}

// ---------------------------------------------------------------------------
// Today's Insights cards (section 2)
// ---------------------------------------------------------------------------

// Nagad/Rocket/Upay/Bkash chip-dot colors — deliberately self-contained here
// rather than reused from WaveTrendChart's own --bkash/--nagad/--upay tokens,
// since those are scoped to `.wtc-panel` only and not readable outside it.
const CHIP_DOT_COLORS: Record<string, string> = {
  Bkash: '#2F6FED',
  Nagad: '#7C5CE0',
  Rocket: '#22B8CF',
  Upay: '#EC8FC0',
};

function QuotaRow({ wallet }: { wallet: ApiTodayWallet }) {
  const hasQuota = !!wallet.quota && wallet.quota > 0;
  if (!hasQuota) {
    return (
      <div className="flex items-center gap-2.5 text-[11px]">
        <span className="w-14 shrink-0 font-semibold text-muted-foreground">{wallet.name}</span>
        <div className="h-1 flex-1 rounded-full bg-white/50 dark:bg-black/20" />
        <span className="shrink-0 text-right text-[10.5px] font-semibold text-muted-foreground">No Quota</span>
      </div>
    );
  }
  const pct = Math.min(Math.round((wallet.value / wallet.quota!) * 100), 100);
  const remaining = Math.max(wallet.quota! - wallet.value, 0);
  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      <span className="w-14 shrink-0 font-semibold text-muted-foreground">{wallet.name}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/60 dark:bg-black/20">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--ui-accent)' }} />
      </div>
      <span
        className={`shrink-0 text-right text-[10.5px] font-bold tabular-nums ${
          remaining <= 0 ? 'text-[color:var(--dd-pos)]' : 'text-muted-foreground'
        }`}
      >
        {remaining <= 0 ? 'Quota met' : `${remaining.toFixed(2)}M left`}
      </span>
    </div>
  );
}

function TodayChip({ wallet }: { wallet: ApiTodayWallet }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DEE1E8] dark:border-[#262B38] bg-white px-2.5 py-1 text-[11px] font-semibold text-muted-foreground dark:bg-[#12151D]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CHIP_DOT_COLORS[wallet.name] ?? 'var(--ui-accent)' }} />
      {wallet.name} <span className="font-bold tabular-nums text-foreground">{wallet.value.toFixed(2)}M</span>
    </span>
  );
}

// CashGo (Cashout) always has a quota concept (Bkash + Nagad, even when one
// has no quota that day) so it renders progress rows; Bundle Transfer (Send
// Money) has no quota concept in the real app at all, so it renders a plain
// chip list instead — branching on `product`, not on the data shape (a day
// where every cashout wallet happens to have quota:0 must still render quota
// rows, not fall back to chips).
function TodayHighlight({ product, progressValue, progressLabel, todayWallets }: { product: Product; progressValue: number; progressLabel: string; todayWallets: ApiTodayWallet[] }) {
  const hasActivity = progressValue > 0;
  const label = product === 'cashout' ? 'CashGo' : 'Bundle Transfer';
  // "Today" in the normal case, else the actual stale business day the
  // server carried this figure forward from (see progressLabel's own
  // comment on ApiOverview) — per explicit instruction, the strip must
  // never claim a carried-forward figure is from today.
  const isToday = progressLabel === 'Today';

  if (!hasActivity) {
    return (
      // min-h-[100px] pins this to the same height the "has activity"
      // variant renders at with CashGo's own (always 2-row) wallet list —
      // so Send Money's "No Activity" state doesn't leave Wallet Breakdown
      // below it sitting at a different row than Cashout's side.
      <div
        className="flex min-h-[100px] flex-col items-center justify-center gap-1.5 rounded-[10px] px-[14px] py-3 text-center"
        style={{ background: 'var(--ui-accent-soft)' }}
      >
        <span className="text-[11.5px] font-normal text-foreground">
          {label} &middot; <span className="font-bold" style={{ color: 'var(--ui-accent)' }}>{progressLabel}</span>
        </span>
        <span className="rounded-full border border-[#DEE1E8] dark:border-[#262B38] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.04em] text-muted-foreground dark:bg-[#12151D]">
          No Activity
        </span>
        <p className="text-[11.5px] text-muted-foreground">
          No wallet has posted a transaction yet {isToday ? 'today' : `on ${progressLabel}`}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] px-[14px] py-3" style={{ background: 'var(--ui-accent-soft)' }}>
      <div className="flex items-center justify-between gap-[10px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[11.5px] font-normal text-foreground">
            {label} &middot; <span className="font-bold" style={{ color: 'var(--ui-accent)' }}>{progressLabel}</span>
          </span>
        </div>
        <span className="shrink-0 text-[16px] font-bold tabular-nums" style={{ color: 'var(--ui-accent)' }}>
          {progressValue.toFixed(2)}M
        </span>
      </div>

      <div className="mt-2.5 border-t border-[#DEE1E8] dark:border-[#262B38] pt-2.5">
        {product === 'cashout' ? (
          <div className="flex flex-col gap-[7px]">
            {todayWallets.map((w) => (
              <QuotaRow key={w.name} wallet={w} />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {todayWallets.map((w) => (
              <TodayChip key={w.name} wallet={w} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Real wallet logos + color-chip fallback — WalletLimitUsedPanel.tsx's own
// WalletLogo is a local copy of this exact pattern (see its own header
// comment), matching this codebase's convention of small per-file helpers
// over a shared component for something this small.
const WALLET_LOGOS: Record<string, string> = {
  BKASH: '/wallets/Bkash.png',
  NAGAD: '/wallets/Nagad.png',
  ROCKET: '/wallets/Rocket.png',
  UPAY: '/wallets/Upay-icon.png',
};
const WALLET_LOGO_COLORS: Record<string, string> = {
  BKASH: '#E2136E',
  NAGAD: '#F5821F',
  ROCKET: '#8C3494',
  UPAY: '#3EB549',
};

function WalletLogo({ walletName }: { walletName: string }) {
  const [imgError, setImgError] = useState(false);
  const key = walletName.toUpperCase();
  const src = WALLET_LOGOS[key];

  if (!src || imgError) {
    return (
      <div
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white"
        style={{ backgroundColor: WALLET_LOGO_COLORS[key] ?? '#94a3b8' }}
      >
        {walletName.charAt(0)}
      </div>
    );
  }

  return (
    <div className="relative h-5 w-5 shrink-0 overflow-hidden rounded-md">
      <Image src={src} alt={walletName} fill sizes="20px" className="object-contain" onError={() => setImgError(true)} />
    </div>
  );
}

function WalletBreakdownTile({ wallet }: { wallet: ApiOverviewWallet }) {
  // How much of the Running Balance is actually inside the wallet right
  // now — full bar at Actual == Running Balance (100%), not a comparison
  // against the other wallet tiles' own totals.
  const pct = wallet.total > 0 ? Math.min(Math.round((wallet.actual / wallet.total) * 100), 100) : 0;
  const up = wallet.change >= 0;
  return (
    <div className="relative rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] p-[10px]">
      <div className="absolute right-[10px] top-[10px]">
        <WalletLogo walletName={wallet.name} />
      </div>
      <p className="mb-[3px] truncate pr-6 text-[11.5px] font-semibold text-foreground">{wallet.name}</p>
      <p className="text-[15px] font-bold tabular-nums text-foreground">{wallet.total.toFixed(2)}M</p>
      <p className={`mt-[1px] text-[10.5px] font-bold ${up ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'}`}>
        {up ? '▲' : '▼'} {Math.abs(wallet.change).toFixed(2)}M
      </p>
      <div className="mt-2 mb-[6px] h-[3px] overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--ui-accent)' }} />
      </div>
      <p className="text-[10.5px] font-semibold leading-[1.4] text-muted-foreground">Actual {wallet.actual.toFixed(2)}M</p>
    </div>
  );
}

function TodaysInsightCard({ product, label, overview }: { product: Product; label: string; overview: ApiOverview }) {
  const endingUp = overview.endingChange >= 0;

  const metrics: { label: string; value: number }[] = [
    { label: 'Opening', value: overview.opening },
    { label: 'Deposit', value: overview.deposit },
    { label: 'Withdrawal', value: overview.withdrawal },
    { label: 'Top Up', value: overview.topup },
    { label: 'Settlement', value: overview.settlement },
  ];

  return (
    // data-product hardcoded to "cashout" (not the real `product`) — both
    // products' Today's Insights cards intentionally share Cashout's indigo
    // --product-accent per explicit design request, overriding this
    // section's own teal. `product` itself still drives the real
    // CashGo/Bundle Transfer label + layout below, untouched.
    <div data-product="cashout" className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-5 py-[18px] dark:bg-[#12151D]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-[14px] font-bold text-foreground">
          <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: 'var(--ui-accent)' }} />
          {label}
        </h3>
        {/* Same "Last Update" treatment as the Balance/Opening pages' own
            header indicator (time only, with seconds, no date), positioned
            upper-right of this card's title row per explicit instruction. */}
        {overview.lastUpdate && (
          <span className="text-[10.5px] text-muted-foreground">
            Last Update: <span className="font-[500]! tabular-nums">{new Date(overview.lastUpdate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}</span>
          </span>
        )}
      </div>

      <div className="mb-4">
        <p className="mb-[3px] text-[11.5px] font-normal text-muted-foreground">Ending Balance</p>
        <p className={`text-[26px] font-bold tabular-nums ${overview.ending < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
          {overview.ending < 0 ? '−' : ''}{fmt(overview.ending)}
        </p>
        <p className={`mt-[7px] inline-flex items-center gap-1 text-[11.5px] font-normal ${endingUp ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'}`}>
          <span>{endingUp ? '▲' : '▼'}</span>
          <span className="tabular-nums">{fmt(overview.endingChange)}</span>
          <span className="font-normal text-muted-foreground">vs opening</span>
        </p>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2 min-[1300px]:grid-cols-5">
        {metrics.map((m) => {
          const disp = neutralDisplayRounded(m.value);
          return (
            <div key={m.label} className="min-w-0 rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] p-[10px]">
              <p className="mb-[5px] truncate text-[9.5px] font-normal uppercase tracking-[0.03em] text-muted-foreground">{m.label}</p>
              {/* No truncate here — unlike the label above, this is a real
                  money figure (e.g. "180,072,878.87"); silently cutting it
                  to "180,072,878…" with an ellipsis is actively misleading
                  for an ops team reading it, confirmed live as the cause of
                  clipped Opening figures in the Telegram screenshot export.
                  Left free to wrap onto a second line instead when a tile
                  is too narrow for it, which never happens for the other,
                  shorter metrics here. */}
              <p className={`text-[12.5px] font-bold leading-[1.3] tabular-nums ${disp.className}`}>{disp.text}</p>
            </div>
          );
        })}
      </div>

      <div className="mb-4">
        <TodayHighlight product={product} progressValue={overview.progressValue} progressLabel={overview.progressLabel} todayWallets={overview.todayWallets} />
      </div>

      <p className="mb-[10px] text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Wallet Breakdown</p>

      <div className="grid grid-cols-2 gap-2 min-[1300px]:grid-cols-4">
        {overview.wallets.map((w) => (
          <WalletBreakdownTile key={w.name} wallet={w} />
        ))}
      </div>
    </div>
  );
}

function InsightCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-5 py-[18px] dark:bg-[#12151D]">
      <SkeletonBlock className="mb-4 h-[22px] w-32" />
      <SkeletonBlock className="mb-1 h-3 w-24" />
      <SkeletonBlock className="mb-3 h-8 w-40" />
      <SkeletonBlock className="mb-4 h-4 w-36" />
      <div className="mb-4 grid grid-cols-3 gap-2 min-[1300px]:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[52px] rounded-lg" />
        ))}
      </div>
      <SkeletonBlock className="mb-4 h-[100px] rounded-[10px]" />
      <SkeletonBlock className="mb-3 h-3 w-32" />
      <div className="grid grid-cols-2 gap-2 min-[1300px]:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[98px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wallet Summary ledger (section 4)
// ---------------------------------------------------------------------------

function WalletSummaryTable({ wallets }: { wallets: ApiWalletLedgerRow[] }) {
  const totals = wallets.reduce(
    (acc, w) => {
      acc.dp += w.dp;
      acc.wd += w.wd;
      acc.mid += w.mid ?? 0;
      acc.settlement += w.settlement ?? 0;
      acc.actual += w.actual;
      acc.running += w.running;
      acc.change += w.change;
      return acc;
    },
    { dp: 0, wd: 0, mid: 0, settlement: 0, actual: 0, running: 0, change: 0 }
  );

  return (
    <section className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-3">
        <h3 className="text-[14px] font-bold text-foreground">Wallet Summary</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-[#DEE1E8] dark:border-[#262B38]">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Wallet</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Total DP</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Total WD</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Top Up / Bundle</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Settlement</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Actual Bal.</th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Running Bal.</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const dp = neutralDisplay(w.dp);
              const wd = neutralDisplay(w.wd);
              const mid = neutralDisplay(w.mid);
              const settlement = neutralDisplay(w.settlement);
              const up = w.change >= 0;
              return (
                <tr key={w.name} className="border-b border-[#EEF0F3] dark:border-[#1D212B] last:border-0 transition-colors hover:bg-muted/10">
                  <td className="whitespace-nowrap px-4 py-3 text-[12.5px] font-semibold text-foreground">{w.name}</td>
                  <td className={`whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums ${dp.className}`}>{dp.text}</td>
                  <td className={`whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums ${wd.className}`}>{wd.text}</td>
                  <td className={`whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums ${mid.className}`}>{mid.text}</td>
                  <td className={`whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums ${settlement.className}`}>{settlement.text}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums text-foreground">{fmt2(w.actual)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums text-foreground">
                    {fmt2(w.running)}
                    <div className={`mt-0.5 text-[10px] font-normal ${up ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'}`}>
                      {up ? '▲' : '▼'} {fmt(w.change)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-[#DEE1E8] dark:border-[#262B38]">
              <td className="whitespace-nowrap px-4 py-3 text-[12.5px] font-semibold text-foreground">Total</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-foreground">{fmt2(totals.dp)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-[color:var(--dd-neg)]">{fmt2(totals.wd)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-foreground">
                {totals.mid ? fmt2(totals.mid) : <span className="text-muted-foreground">&minus;</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-foreground">
                {totals.settlement ? fmt2(totals.settlement) : <span className="text-muted-foreground">&minus;</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-foreground">{fmt2(totals.actual)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-xs font-bold tabular-nums text-foreground">
                {fmt2(totals.running)}
                <div className={`mt-0.5 text-[10px] font-bold ${totals.change >= 0 ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'}`}>
                  {totals.change >= 0 ? '▲' : '▼'} {fmt(totals.change)}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// Column widths for the 7-col ledger table below — the Wallet name column
// reads noticeably wider than the numeric columns, same as the real table,
// instead of 7 identical flex-1 bars.
const LEDGER_SKELETON_COL_WIDTHS = ['flex-[1.6]', 'flex-1', 'flex-1', 'flex-1', 'flex-1', 'flex-[0.85]', 'flex-[0.85]'];

// Same idea for the Running Balance / Cash In Hand tables — Brand name
// column wider than the 6 numeric columns beside it.
const BRAND_TABLE_SKELETON_COL_WIDTHS = ['flex-[1.3]', 'flex-1', 'flex-1', 'flex-1', 'flex-1', 'flex-1', 'flex-[0.9]'];

function LedgerSkeleton() {
  // Mirrors WalletSummaryTable's real shape: a bordered title row, then a
  // 7-column table (Wallet/Total DP/Total WD/Top Up/Settlement/Actual/
  // Running) — not a flat 2-value-per-row list, which read narrower than
  // the real ledger ever renders.
  return (
    <div className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-3">
        <SkeletonBlock className="h-4 w-32" />
      </div>
      <div className="flex gap-4 border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-3">
        {LEDGER_SKELETON_COL_WIDTHS.map((w, i) => (
          <SkeletonBlock key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-[19px] last:border-0">
          {LEDGER_SKELETON_COL_WIDTHS.map((w, j) => (
            <SkeletonBlock key={j} className={`h-3 ${w}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top Performer Wallet + High Volume Agents (section 5)
// ---------------------------------------------------------------------------

type RankRow = { key: string; name: string; mono?: boolean; sub: string; value: number };

function RankPanel({
  title,
  tag,
  pill,
  rows,
  scrollable,
  grow,
  highlightFirst,
}: {
  title: string;
  tag: string;
  pill?: boolean;
  rows: RankRow[];
  scrollable?: boolean;
  // Matches the demo's .rank-panel.grow — only the second (High Volume
  // Agents) panel in the side-col flexes to fill whatever height the
  // ResizeObserver in ProductBlock pinned the grid row to; Top Performer
  // Wallet keeps its own natural height, same as the demo.
  grow?: boolean;
  highlightFirst?: boolean;
}) {
  const list = (
    <div className="flex flex-col gap-1">
      {rows.length === 0 && <p className="px-1.5 py-6 text-center text-[11px] text-muted-foreground">No data.</p>}
      {rows.map((r, i) => {
        const neg = r.value < 0;
        const hi = Boolean(highlightFirst) && i === 0;
        return (
          <div
            key={r.key}
            className="flex items-center gap-2.5 rounded-lg px-1.5 py-2"
            style={hi ? { background: 'var(--dd-neg-dim)' } : undefined}
          >
            <span className={`w-5 shrink-0 text-[10.5px] font-normal tabular-nums ${hi ? 'text-[color:var(--dd-neg)]' : 'text-muted-foreground'}`}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-foreground ${r.mono ? 'text-[10.5px] font-medium' : 'text-[11.5px] font-semibold'}`}>{r.name}</p>
              <p className="truncate text-[10px] text-muted-foreground">{r.sub}</p>
            </div>
            <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${neg ? 'text-[color:var(--dd-neg)]' : 'text-[color:var(--dd-pos)]'}`}>
              {neg ? '−' : '+'}{fmt(r.value)}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      className={`flex flex-col rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-[18px] py-4 dark:bg-[#12151D] ${
        grow ? 'min-[1100px]:min-h-0 min-[1100px]:flex-1' : ''
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[12.5px] font-semibold text-foreground">{title}</h3>
        <span
          className={pill ? 'rounded-full px-2 py-0.5 text-[10px] font-normal' : 'text-[10px] font-normal text-muted-foreground'}
          style={pill ? { background: 'var(--ui-accent-soft)', color: 'var(--ui-accent)' } : undefined}
        >
          {tag}
        </span>
      </div>
      {scrollable ? (
        <div className={`max-h-[420px] overflow-y-auto pr-1 ${grow ? 'min-[1100px]:max-h-none min-[1100px]:min-h-0 min-[1100px]:flex-1' : ''}`}>{list}</div>
      ) : (
        list
      )}
    </div>
  );
}

// Note: the demo's own font for rank-name.mono is Space Grotesk (--mono) —
// this project never uses font-mono anywhere (see CLAUDE.md). Agent codes
// (`r.mono`) render in the same Inter as everything else; the `mono` flag
// only shrinks the size and drops the font-weight, no font-family change.

function RankPanelSkeleton({ rows, className }: { rows: number; className?: string }) {
  // max-h-[600px] (~ProductBlock's own real mainCol height once loaded, per
  // live measurement) + overflow-hidden bound this directly on the
  // component itself — flex-1 alone clips against nothing here, since the
  // ResizeObserver that gives the real "grow" panel its own explicit height
  // only exists once real content (and gridRef/mainColRef) mounts, not
  // during the skeleton phase. Without an explicit bound, a high row count
  // just renders at full natural height instead of being clipped, which
  // blew the panel far taller than the rest of the page.
  return (
    <div className={`flex max-h-[600px] flex-col overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-[18px] py-4 dark:bg-[#12151D] ${className ?? ''}`}>
      <SkeletonBlock className="mb-3 h-4 w-36 shrink-0" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex shrink-0 items-center gap-2.5">
            <SkeletonBlock className="h-3 w-5" />
            <SkeletonBlock className="h-[42px] flex-1 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Running Balance card's own compact trend — same straight-line-plus-
// gradient-fill style as CashGo Trend/Bundle Transfer Trend (WaveTrendChart),
// scaled down with no axis/legend/tooltip to fit the KPI card's right side.
// #2F6FED matches WaveTrendChart's own `--bkash` token value (that CSS var
// is scoped to `.wtc-panel`, not in scope here, hence the literal hex) — the
// same blue every trend line on this page now uses. `idSuffix` keeps the two
// products' gradient ids from colliding since both render on the same page.
function OpeningTrendSparkline({ points, idSuffix }: { points: { date: string; value: number }[]; idSuffix: string }) {
  const W = 100;
  const H = 40;
  const gradId = `ots-${idSuffix}`;

  if (points.length < 2) {
    return <div className="h-[46px] w-[84px] shrink-0" />;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, min + 1);
  const range = max - min || 1;
  const xStep = W / (points.length - 1);
  const coords = points.map((p, i) => [i * xStep, H - ((p.value - min) / range) * H] as const);
  const linePath = coords.reduce((d, [x, y], i) => `${d}${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)} `, '');
  const areaPath = `${linePath}L ${coords[coords.length - 1][0].toFixed(1)},${H} L ${coords[0][0].toFixed(1)},${H} Z`;

  return (
    <div className="h-[46px] w-[84px] shrink-0">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2F6FED" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2F6FED" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke="#2F6FED" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product block — trend chart + ledger (main column) beside Top
// Performer/High Volume Agents (side column), one per product.
// ---------------------------------------------------------------------------

function ProductBlock({
  title,
  product,
  dep,
  wd,
  running,
  changeVsOpening,
  chartTitle,
  chartSubtitle,
  series,
  tooltipSeries,
  chart,
  chart30,
  openingTrend,
  wallets,
  topPerformers,
  agents,
}: {
  title: string;
  product: Product;
  dep: number;
  wd: number;
  running: number;
  changeVsOpening: number;
  chartTitle: string;
  chartSubtitle: string;
  series: WaveTrendSeriesDef[];
  tooltipSeries: WaveTrendSeriesDef[];
  chart: WaveTrendDataPoint[];
  chart30: WaveTrendDataPoint[];
  openingTrend: { date: string; value: number }[];
  wallets: ApiWalletLedgerRow[];
  topPerformers: ApiTopPerformer[];
  agents: ApiAgent[];
}) {
  const topPerformerRows: RankRow[] = topPerformers.map((p) => ({
    key: p.wallet,
    name: p.wallet,
    sub: `Bal ${fmt(p.actualBal)}`,
    value: p.gain,
  }));
  const agentRows: RankRow[] = agents.map((a) => ({
    key: a.agentName,
    name: a.agentName,
    mono: true,
    sub: `Inside ${fmt(a.balanceInside)}`,
    value: a.runningBalance - a.opening,
  }));

  const heroUp = changeVsOpening >= 0;

  // Memoized (not computed inline in JSX) so WaveTrendChart's own
  // useEffect — keyed on referential identity of `data`/`data30` — doesn't
  // see a new array on every unrelated re-render and spuriously replay its
  // fade-in draw-in animation.
  const totalChart = useMemo(() => withTotal(chart), [chart]);
  const totalChart30 = useMemo(() => withTotal(chart30), [chart30]);

  // Ports the demo's own syncDashGridHeight(): pins the grid row's height to
  // main-col's natural (unstretched) height, so side-col's 50-row agents
  // list scrolls within that bound instead of dictating a taller row than
  // the chart+ledger column — a ResizeObserver is the React-idiomatic
  // equivalent of the demo's manual resize-listener + re-render calls, and
  // additionally reacts to the row-count changes a fixed max-height never
  // could (mock vs live data, Cashout vs Send Money wallet counts differ).
  const gridRef = useRef<HTMLDivElement>(null);
  const mainColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mainCol = mainColRef.current;
    const grid = gridRef.current;
    if (!mainCol || !grid) return;
    const sync = () => {
      if (window.innerWidth >= 1100) {
        grid.style.gridTemplateRows = `${Math.ceil(mainCol.getBoundingClientRect().height)}px`;
      } else {
        grid.style.gridTemplateRows = '';
      }
    };
    const observer = new ResizeObserver(sync);
    observer.observe(mainCol);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [wallets, chart, chart30]);

  return (
    <div data-product={product}>
      <SectionLabel>{title}</SectionLabel>

      <div ref={gridRef} className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-[2.1fr_1fr]">
        <div ref={mainColRef} className="flex flex-col gap-[14px] min-[1100px]:self-start">
          {/* Shares this row's top edge with the side column (Top Performer
              Wallet) below at >=1100px, so the KPI row lives inside main-col
              instead of spanning the full page width. 2fr/1fr/1fr keeps
              Running Balance's width effectively unchanged from its old
              full-width equal-third share; Total Deposit/Total Withdrawal
              split what's left — kept from `sm` up (not gated behind 1100px)
              since the ratio still reads correctly even while main/side
              haven't split yet. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-5 py-4 dark:bg-[#12151D]">
              <div className="flex min-w-0 flex-1 flex-col justify-between self-stretch">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Running Balance</p>
                  <p className="mt-1.5 text-[28px] font-semibold tabular-nums text-foreground">
                    <sup className="mr-0.5 text-[14px] font-medium text-muted-foreground">&#2547;</sup>
                    {fmtM(running)}M
                  </p>
                </div>
                <span
                  className={`mt-2 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[12px] tabular-nums ${
                    heroUp ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'
                  }`}
                  style={{ background: heroUp ? 'var(--dd-pos-dim)' : 'var(--dd-neg-dim)' }}
                >
                  {heroUp ? '▲' : '▼'} {fmtM(changeVsOpening)}M vs opening
                </span>
              </div>
              <OpeningTrendSparkline points={openingTrend} idSuffix={product} />
            </div>

            <div className="flex flex-col justify-between rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-5 py-4 dark:bg-[#12151D]">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Total Deposit</p>
              </div>
              <div>
                <p className="text-[24px] font-semibold tabular-nums text-foreground">{fmtM(dep)}M</p>
                <p className="mt-1.5 text-[11px] tabular-nums text-foreground">{fmt(dep)}</p>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-5 py-4 dark:bg-[#12151D]">
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Total Withdrawal</p>
              </div>
              <div>
                <p className="text-[24px] font-semibold tabular-nums text-[color:var(--dd-neg)]">{fmtM(wd)}M</p>
                <p className="mt-1.5 text-[11px] tabular-nums text-foreground">{fmt(wd)}</p>
              </div>
            </div>
          </div>

          {/* data-product hardcoded to "cashout" (like TodaysInsightCard
              above) — the trend chart's 7D/30D toggle etc. read
              --product-accent, and both products intentionally share
              Cashout's indigo there too. `className="contents"` (same
              pattern as AppShell's own data-product wrapper) keeps this a
              pure CSS-var scope with no box-model effect on the flex-col
              layout around it. */}
          <div data-product="cashout" className="contents">
            <WaveTrendChart
              data={totalChart}
              data30={totalChart30}
              series={series}
              tooltipSeries={tooltipSeries}
              title={chartTitle}
              subtitle={chartSubtitle}
            />
          </div>
          <WalletSummaryTable wallets={wallets} />
        </div>
        <div className="flex flex-col gap-[14px] min-[1100px]:h-full">
          <RankPanel title="Top Performer Wallet" tag="Net P&L" rows={topPerformerRows} highlightFirst />
          <RankPanel title="High Volume Agents" tag="TOP 50" pill rows={agentRows} scrollable grow />
        </div>
      </div>
    </div>
  );
}

function ProductBlockSkeleton() {
  return (
    <div>
      <SkeletonBlock className="mb-3 h-3 w-48" />
      {/* Mirrors ProductBlock's real nesting: the KPI row lives inside
          main-col (sharing the side column's top edge), not as its own
          full-width row above the 2.1fr/1fr split — the two used to
          disagree here, which is what threw off the loading state's sizing
          against the real layout. */}
      <div className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-[2.1fr_1fr]">
        <div className="flex flex-col gap-[14px]">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-[118px] rounded-lg" />
            ))}
          </div>
          <div className="rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white px-[22px] py-5 dark:bg-[#12151D]">
            <div className="flex items-center justify-between gap-[10px]">
              <div className="min-w-0 flex-1">
                <SkeletonBlock className="mb-1.5 h-4 w-32" />
                <SkeletonBlock className="h-3 w-44" />
              </div>
              <SkeletonBlock className="h-[26px] w-[110px] shrink-0 rounded-[7px]" />
            </div>
            <SkeletonBlock className="mt-3.5 h-3.5 w-28" />
            <SkeletonBlock className="mt-[22px] h-[230px] rounded-lg" />
          </div>
          <LedgerSkeleton />
        </div>
        <div className="flex flex-col gap-[14px] min-[1100px]:h-full">
          <RankPanelSkeleton rows={4} />
          <RankPanelSkeleton rows={12} className="min-[1100px]:flex-1" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running Balance by Brand (section 6)
// ---------------------------------------------------------------------------

type BrandBalanceColumnKey = 'staticOpening' | 'staticDeposit' | 'staticWithdrawal' | 'topUp' | 'settlement' | 'staticTotal';
type BrandBalanceSortKey = 'brand' | BrandBalanceColumnKey;

const BRAND_BALANCE_COLUMNS: { key: BrandBalanceColumnKey; label: string }[] = [
  { key: 'staticOpening', label: 'Opening' },
  { key: 'staticDeposit', label: 'Deposit' },
  { key: 'staticWithdrawal', label: 'Withdrawal' },
  { key: 'topUp', label: 'Top Up' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'staticTotal', label: 'Total' },
];

// Opening/Deposit/Withdrawal/Total used to render blank here (Phase 10 —
// no live upload system existed yet for them, so the sheet's own static
// columns weren't trusted for display). Both products' brandBalance rows
// now come from Daily Transaction Entry's own ledger cards (see
// app/api/dashboard/route.ts's getDailyTxnLedgerBrandTotals) — a real, live
// source, not a stale manual sheet column — so nothing needs blanking
// anymore. Kept as empty sets (not a removed prop) so blankKeys stays
// available if a future column ever needs the same "display-only" treatment
// again.
const BLANK_KEYS_CASHOUT = new Set<BrandBalanceColumnKey>();
const BLANK_KEYS_SENDMONEY = new Set<BrandBalanceColumnKey>();
const BLANK_DISPLAY = { text: '−', className: 'text-muted-foreground' };

function BrandValueCell({
  value,
  blank,
  bold,
  totalRow,
}: {
  value: number;
  blank?: boolean;
  bold?: boolean;
  // pt-[14px] instead of py-[11px] — matches the demo's tr.total-row td
  // (padding-top:14px override on top of table.ledger td's own
  // padding:11px 0 — bottom/left/right fall through unchanged).
  totalRow?: boolean;
}) {
  const display = blank ? BLANK_DISPLAY : cihValueDisplay(value);
  return (
    <td
      className={`whitespace-nowrap text-right text-[12px] tabular-nums ${totalRow ? 'pb-[11px] pt-[14px]' : 'py-[11px]'} ${
        bold ? 'font-bold' : 'font-normal'
      } ${display.className}`}
    >
      {display.text}
    </td>
  );
}

function RunningBalanceByBrandSection({
  rows,
  title,
  subtitle,
  exportFileName,
  exportSheetName,
  blankKeys,
}: {
  rows: ApiBrandBalance[];
  title: string;
  subtitle: string;
  exportFileName: string;
  exportSheetName: string;
  blankKeys: Set<BrandBalanceColumnKey>;
}) {
  // No default sort — first click sorts desc, second asc, third returns to
  // unsorted. Ported from the pre-redesign app/page.tsx's SspLine1Section.
  const [sortColumn, setSortColumn] = useState<BrandBalanceSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleHeaderClick = useCallback((key: BrandBalanceSortKey) => {
    if (sortColumn !== key) {
      setSortColumn(key);
      setSortDirection('desc');
    } else if (sortDirection === 'desc') {
      setSortDirection('asc');
    } else {
      setSortColumn(null);
      setSortDirection('desc');
    }
  }, [sortColumn, sortDirection]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      if (sortColumn === 'brand') {
        const comparison = a.brand.localeCompare(b.brand);
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const comparison = a[sortColumn] - b[sortColumn];
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [rows, sortColumn, sortDirection]);

  const totals = useMemo(
    () => BRAND_BALANCE_COLUMNS.reduce((acc, col) => {
      acc[col.key] = rows.reduce((sum, row) => sum + row[col.key], 0);
      return acc;
    }, {} as Record<BrandBalanceColumnKey, number>),
    [rows]
  );

  const handleExport = useCallback(() => {
    const headers = ['Brand', ...BRAND_BALANCE_COLUMNS.map((c) => c.label)];
    const data = rows.map((row) => [row.brand, ...BRAND_BALANCE_COLUMNS.map((c) => row[c.key])]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, exportSheetName);
    XLSX.writeFile(workbook, xlsxTimestampedFilename(exportFileName));
  }, [rows, exportFileName, exportSheetName]);

  return (
    <section className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="px-5 pb-[18px] pt-[18px] sm:pb-0">
        <div className="mb-[14px] flex items-center gap-[10px]">
          <div className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] text-[#6B7280] dark:bg-[#1A1E29] dark:text-[#9198AC]">
            <Wallet size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13.5px] font-bold text-foreground">{title}</h2>
            <p className="mt-[1px] truncate text-[11px] text-muted-foreground">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={handleExport}
            className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] px-3 py-1.5 text-[11.5px] font-semibold text-[#6B7280] hover:text-foreground hover:border-[var(--ui-accent)] dark:bg-[#1A1E29] dark:text-[#9198AC]"
          >
            <Download size={12} />
            Export
          </button>
        </div>

        <div className="hidden overflow-x-auto pb-[18px] sm:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#DEE1E8] dark:border-[#262B38]">
                <th className="whitespace-nowrap pb-[10px] text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  <button type="button" onClick={() => handleHeaderClick('brand')} className="flex items-center gap-1 hover:opacity-80">
                    Brand
                    <SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                  </button>
                </th>
                {BRAND_BALANCE_COLUMNS.map((col) => (
                  <th key={col.key} className="whitespace-nowrap pb-[10px] text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                    <button type="button" onClick={() => handleHeaderClick(col.key)} className="flex w-full items-center justify-end gap-1 hover:opacity-80">
                      {col.label}
                      <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.brand} className="border-b border-[#EEF0F3] dark:border-[#1D212B] last:border-0 transition-colors hover:bg-muted/10">
                  <td className="whitespace-nowrap py-[11px] text-left text-[12.5px] font-semibold text-foreground">{row.brand}</td>
                  {BRAND_BALANCE_COLUMNS.map((col) => (
                    <BrandValueCell key={col.key} value={row[col.key]} blank={blankKeys.has(col.key)} bold={col.key === 'staticTotal'} />
                  ))}
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-[#DEE1E8] dark:border-[#262B38]">
                  <td className="whitespace-nowrap pb-[11px] pt-[14px] text-left text-[12.5px] font-bold" style={{ color: 'var(--ui-accent)' }}>Total</td>
                  {BRAND_BALANCE_COLUMNS.map((col) => (
                    <BrandValueCell key={col.key} value={totals[col.key]} blank={blankKeys.has(col.key)} bold totalRow />
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-[18px] sm:hidden">
        {sortedRows.map((row) => (
          <div key={row.brand} className="rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white p-4 dark:bg-[#12151D]">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
              <div className="text-right">
                <p className="text-[11px] text-muted-foreground">Total</p>
                {(() => {
                  const display = blankKeys.has('staticTotal') ? BLANK_DISPLAY : cihValueDisplay(row.staticTotal);
                  return <p className={`text-lg font-bold tabular-nums ${display.className}`}>{display.text}</p>;
                })()}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-[#DEE1E8] dark:border-[#262B38] pt-3">
              {BRAND_BALANCE_COLUMNS.filter((col) => col.key !== 'staticTotal').map((col) => {
                const display = blankKeys.has(col.key) ? BLANK_DISPLAY : cihValueDisplay(row[col.key]);
                return (
                  <div key={col.key} className="min-w-0">
                    <p className="text-[11px] text-muted-foreground">{col.label}</p>
                    <p className={`mt-0.5 text-[10.5px] font-medium tabular-nums ${display.className}`}>{display.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunningBalanceSkeleton() {
  // Mirrors the real section's own shape: no border under the icon/title/
  // Export header (unlike CashInHandSkeleton below, which does have one),
  // then a 7-column table (Brand + 6 BRAND_BALANCE_COLUMNS) with 10 brand
  // rows + a Total row — not a flat 2-value list, which read far narrower/
  // shorter than the real table ever renders.
  return (
    <section className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="px-5 pb-[18px] pt-[18px]">
        <div className="mb-[14px] flex items-center gap-[10px]">
          <SkeletonBlock className="h-[28px] w-[28px] shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="mt-1.5 h-3 w-56" />
          </div>
          <SkeletonBlock className="h-8 w-24 shrink-0 rounded-[7px]" />
        </div>
        <div className="flex gap-4 border-b border-[#DEE1E8] pb-[10px] dark:border-[#262B38]">
          {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, i) => (
            <SkeletonBlock key={i} className={`h-3 ${w}`} />
          ))}
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-[#EEF0F3] py-[11px] dark:border-[#1D212B]">
            {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, j) => (
              <SkeletonBlock key={j} className={`h-3 ${w}`} />
            ))}
          </div>
        ))}
        <div className="flex items-center gap-4 pb-[11px] pt-[14px]">
          {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, i) => (
            <SkeletonBlock key={i} className={`h-3 ${w}`} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cash In Hand (section 7)
// ---------------------------------------------------------------------------

type CihColumnKey = 'sspAg' | 'sspPs' | 'ess' | 'autopay' | 'expay' | 'totalBrandCIH';
type CihSortKey = 'brand' | CihColumnKey;

const CIH_COLUMNS: { key: CihColumnKey; label: string }[] = [
  { key: 'sspAg', label: 'CashOut' },
  { key: 'sspPs', label: 'SendMoney' },
  { key: 'ess', label: 'ESS' },
  { key: 'autopay', label: 'Autopay' },
  { key: 'expay', label: 'Expay' },
  { key: 'totalBrandCIH', label: 'Total CIH' },
];

function NotSupportedCell() {
  return (
    <td className="whitespace-nowrap px-4 py-3 text-center text-[12px] font-normal italic text-muted-foreground">
      Not Supported
    </td>
  );
}

function CihCell({ value, bold }: { value: number; bold?: boolean }) {
  const display = cihValueDisplay(value);
  return (
    <td className={`whitespace-nowrap px-4 py-3 text-center text-[12px] tabular-nums ${bold ? 'font-bold' : 'font-normal'} ${display.className}`}>
      {display.text}
    </td>
  );
}

function CashInHandSection({ rows, total }: { rows: ApiCashInHand[]; total: ApiCashInHand | null }) {
  const [sortColumn, setSortColumn] = useState<CihSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleHeaderClick = useCallback((key: CihSortKey) => {
    if (sortColumn !== key) {
      setSortColumn(key);
      setSortDirection('desc');
    } else if (sortDirection === 'desc') {
      setSortDirection('asc');
    } else {
      setSortColumn(null);
      setSortDirection('desc');
    }
  }, [sortColumn, sortDirection]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      if (sortColumn === 'brand') {
        const comparison = a.brand.localeCompare(b.brand);
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const comparison = a[sortColumn] - b[sortColumn];
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [rows, sortColumn, sortDirection]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: ApiCashInHand, key: CihColumnKey) => {
      if (key === 'autopay' && !row.autopaySupported) return 'Not Supported';
      return row[key];
    };
    const headers = ['Brand', ...CIH_COLUMNS.map((c) => c.label)];
    const data = rows.map((row) => [row.brand, ...CIH_COLUMNS.map((c) => getExportValue(row, c.key))]);
    if (total) data.push([total.brand, ...CIH_COLUMNS.map((c) => total[c.key])]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Brand Balance');
    XLSX.writeFile(workbook, xlsxTimestampedFilename('BRAND_BALANCE'));
  }, [rows, total]);

  return (
    <section className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="flex items-center justify-between gap-3 border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] text-[#6B7280] dark:bg-[#1A1E29] dark:text-[#9198AC]">
            <Building2 size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[13.5px] font-bold text-foreground">Brand Balance</h2>
            <p className="truncate text-[11px] text-muted-foreground">Summary of cash in hand by brand and payment gateway</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          <Download size={13} />
          Export
        </button>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-[#DEE1E8] dark:border-[#262B38]">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                <button type="button" onClick={() => handleHeaderClick('brand')} className="flex items-center gap-1 hover:opacity-80">
                  Brand
                  <SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </th>
              {CIH_COLUMNS.map((col) => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-center text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  <button type="button" onClick={() => handleHeaderClick(col.key)} className="flex w-full items-center justify-center gap-1 hover:opacity-80">
                    {col.label}
                    <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.brand} className="border-b border-[#EEF0F3] dark:border-[#1D212B] last:border-0 transition-colors hover:bg-muted/10">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[12.5px] font-semibold text-foreground">{row.brand}</td>
                {CIH_COLUMNS.map((col) =>
                  col.key === 'autopay' && !row.autopaySupported ? (
                    <NotSupportedCell key={col.key} />
                  ) : (
                    <CihCell key={col.key} value={row[col.key]} bold={col.key === 'totalBrandCIH'} />
                  )
                )}
              </tr>
            ))}
          </tbody>
          {total && (
            <tfoot>
              <tr className="border-t border-[#DEE1E8] dark:border-[#262B38]">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[12.5px] font-semibold text-foreground">{total.brand}</td>
                {CIH_COLUMNS.map((col) => (
                  <CihCell key={col.key} value={total[col.key]} bold />
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.map((row) => {
          const totalDisplay = cihValueDisplay(row.totalBrandCIH);
          return (
            <div key={row.brand} className="rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white p-4 dark:bg-[#12151D]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total CIH</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-[#DEE1E8] dark:border-[#262B38] pt-3">
                {CIH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => {
                  const notSupported = col.key === 'autopay' && !row.autopaySupported;
                  const display = cihValueDisplay(row[col.key]);
                  return (
                    <div key={col.key} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{col.label}</p>
                      {notSupported ? (
                        <p className="mt-0.5 text-[10.5px] font-medium italic text-muted-foreground">Not Supported</p>
                      ) : (
                        <p className={`mt-0.5 text-[10.5px] font-medium tabular-nums ${display.className}`}>{display.text}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {total && (() => {
          const totalDisplay = cihValueDisplay(total.totalBrandCIH);
          return (
            <div className="rounded-lg border-2 border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{total.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total CIH</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-[#DEE1E8] dark:border-[#262B38] pt-3">
                {CIH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => {
                  const display = cihValueDisplay(total[col.key]);
                  return (
                    <div key={col.key} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{col.label}</p>
                      <p className={`mt-0.5 text-[10.5px] font-bold tabular-nums ${display.className}`}>{display.text}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
    </section>
  );
}

function CashInHandSkeleton() {
  // 7-column table (Brand + 6 CIH_COLUMNS) with 10 brand rows + a Total
  // row, matching the real CashInHandSection — same fix as
  // RunningBalanceSkeleton above, just keeping this section's own header
  // border (the real header here does have a border-b, unlike Running
  // Balance's).
  return (
    <section className="overflow-hidden rounded-lg border border-[#DEE1E8] dark:border-[#262B38] bg-white dark:bg-[#12151D]">
      <div className="flex items-center justify-between gap-3 border-b border-[#DEE1E8] dark:border-[#262B38] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <SkeletonBlock className="h-[28px] w-[28px] shrink-0 rounded-lg" />
          <div>
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="mt-1.5 h-3 w-56" />
          </div>
        </div>
        <SkeletonBlock className="h-8 w-24 shrink-0 rounded-lg" />
      </div>
      <div className="flex gap-4 border-b border-[#DEE1E8] px-4 py-3 dark:border-[#262B38]">
        {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, i) => (
          <SkeletonBlock key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-[#EEF0F3] px-4 py-3 dark:border-[#1D212B]">
          {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, j) => (
            <SkeletonBlock key={j} className={`h-3 ${w}`} />
          ))}
        </div>
      ))}
      <div className="flex items-center gap-4 px-4 py-3">
        {BRAND_TABLE_SKELETON_COL_WIDTHS.map((w, i) => (
          <SkeletonBlock key={i} className={`h-3 ${w}`} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { theme, toggleTheme } = useTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [telegramSending, setTelegramSending] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const res = await fetch(`/api/dashboard?t=${Date.now()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Request failed with status ${res.status}`);
      }
      const json = (await res.json()) as DashboardData & { error?: string };
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same pattern every fetching page in this codebase uses
    // (see e.g. app/balance-overview/page.tsx, app/agentbal/page.tsx) — the
    // new react-hooks `set-state-in-effect` rule flags this app-wide, not
    // something specific to this page; not restructured here to stay
    // consistent with the rest of the app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  // Sends Today's Insights (both product cards) and Brand Balance as one
  // grouped Telegram album — same /api/telegram/screenshot + `[data-
  // telegram-capture]` selector mechanism already proven on
  // app/shadcn-demo/balance-overview/page.tsx, just pointed at this page's
  // own two sections instead.
  const handleSendToTelegram = useCallback(async () => {
    setTelegramSending(true);
    try {
      const res = await fetch('/api/telegram/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/',
          label: 'Operations Overview',
          captures: ['[data-telegram-capture="cards"]', '[data-telegram-capture="brand"]'],
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Failed to send screenshot.');
      }
      setToast({ type: 'success', message: 'Sent to Telegram.' });
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to send screenshot.' });
    } finally {
      setTelegramSending(false);
    }
  }, []);

  return (
    <div className="dd-page min-h-screen bg-[#F7F8FA] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#0A0C11] dark:text-white">
      {/* Tailwind's Preflight sets an ambient line-height:1.5 on <html>, which
          every text-[Npx] arbitrary-size class in this file inherits (they
          don't bundle their own line-height the way named sizes like
          text-sm do). The demo never had this — its text renders at the
          browser/font's natural "normal" line-height, which is visibly
          tighter. That mismatch compounds across every stacked text block
          (a wallet tile alone has 4 lines) into real, cumulative excess
          height — this is the actual "spacing" issue, not a padding/margin
          error. Resetting to line-height:normal here (0-specificity :where,
          so any element that DOES want an explicit leading-* still wins)
          reproduces the demo's metrics without touching Tailwind's global
          preflight, which every other page in the app still relies on. */}
      {/* Exact demo positive/negative tokens — Tailwind's emerald-600/rose-600
          only approximate the demo's --pos/--neg (green-600 #16A34A and a
          custom red #E23D3D in light mode; the dark-mode values happen to
          equal emerald-400/an off-rose red). Defining them exactly here
          (same pattern WaveTrendChart's own .wtc-panel scope already uses)
          means every text-[color:var(--dd-pos)]/--dd-neg below renders the
          demo's literal hex in both themes instead of a close approximation. */}
      <style>{`
        .dd-page :where(h1, h2, h3, p, span, td, th) { line-height: normal; }
        .dd-page {
          --dd-pos: #16A34A; --dd-neg: #E23D3D; --dd-pos-dim: rgba(22,163,74,.10); --dd-neg-dim: rgba(226,61,61,.10);
          --ink-0: #F7F8FA; --ink-1: #FFFFFF; --ink-2: #F1F2F5; --hair: #DDE0E7;
          --text-hi: #1A1D23; --text-mid: #6B7280; --text-low: #9CA3AF;
        }
        .dark .dd-page {
          --dd-pos: #34D399; --dd-neg: #F4665A; --dd-pos-dim: rgba(52,211,153,.12); --dd-neg-dim: rgba(244,102,90,.12);
          --ink-0: #0A0C11; --ink-1: #12151D; --ink-2: #1A1E29; --hair: #262B38;
          --text-hi: #F3F4F7; --text-mid: #9198AC; --text-low: #565C70;
        }
      `}</style>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      {/* Demo's own .content/.wrap split: outer padding is edge-to-edge,
          but the content itself caps at 1400px and centers — without this,
          every card stretches to the full viewport width on a wide monitor
          and reads noticeably larger/looser than the demo. */}
      <main className="px-4 pb-6 md:px-[28px] md:pb-8">
        {/* PageHeader (containerless/sticky) lives INSIDE this same
            max-w-[1400px] wrapper, as the first child — not as a separate
            sibling above <main> the way every other page's header is. See
            the long comment on ContainerlessHeader in PageHeader.tsx for
            why: position:sticky needs its own direct parent to be as tall
            as the whole scrollable page, not just the header's own height,
            or it stops sticking the moment you scroll past the header. */}
        <div className="mx-auto max-w-[1400px]">
        <PageHeader
          title="Operations Overview"
          containerless
          actions={
            <>
              <button
                onClick={handleSendToTelegram}
                disabled={telegramSending || loading}
                aria-label="Send to Telegram"
                title="Send to Telegram"
                className={`flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-[#6B7280] hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)] disabled:opacity-50 dark:text-[#9198AC] ${
                  // Pulse (not spin) while sending — same dt-skeleton-pulse
                  // rhythm used for every other loading placeholder in the
                  // app, per explicit instruction: the icon shouldn't
                  // rotate, the whole button should shimmer in place.
                  telegramSending ? 'pointer-events-none animate-[dt-skeleton-pulse_1.3s_ease-in-out_infinite]' : ''
                }`}
              >
                <Send size={11} />
              </button>
              <button
                onClick={fetchData}
                disabled={spinning}
                aria-label="Refresh"
                title="Refresh"
                className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-[#6B7280] hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)] disabled:opacity-50 dark:text-[#9198AC]"
              >
                {/* Same hand-drawn icon as WaveTrendChart's own "Replay
                    animation" button (not a lucide icon) — explicit design
                    reference, kept pixel-identical rather than swapped for
                    a lucide equivalent, idle color included (#6B7280 /
                    dark:#9198AC on the button itself above). Spins in
                    place while loading. */}
                <svg
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  fill="none"
                  className={spinning ? 'animate-spin' : ''}
                  style={{ color: spinning ? 'var(--ui-accent)' : undefined }}
                >
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={toggleTheme}
                aria-label="Toggle light and dark mode"
                title="Toggle light and dark mode"
                className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-[#6B7280] hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)] dark:text-[#9198AC]"
              >
                {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
              </button>
              <AccountMenu compact />
            </>
          }
        />
        {/* No space-y gutter — every section starts with SectionLabel, whose
            own margin:22px 0 10px (matching the demo) is the sole spacer
            between sections. Stacking a wrapper gutter on top would double
            it. */}
        {loading && (
          <>
            <section>
              <SkeletonBlock className="mb-3 h-3 w-32" />
              <div className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-2">
                <InsightCardSkeleton />
                <InsightCardSkeleton />
              </div>
            </section>
            <ProductBlockSkeleton />
            <ProductBlockSkeleton />
            <section>
              <SkeletonBlock className="mb-3 h-3 w-56" />
              <div className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-2">
                <RunningBalanceSkeleton />
                <RunningBalanceSkeleton />
              </div>
            </section>
            <section>
              <SkeletonBlock className="mb-3 h-3 w-56" />
              <CashInHandSkeleton />
            </section>
          </>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && data && (
          <>
            <section data-telegram-capture="cards">
              <SectionLabel>Today&rsquo;s Insights</SectionLabel>
              <div className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-2">
                <TodaysInsightCard product="cashout" label="Cashout" overview={data.cashout.overview} />
                <TodaysInsightCard product="sendmoney" label="Send Money" overview={data.sendmoney.overview} />
              </div>
            </section>

            <ProductBlock
              title="SSP Line 1 &middot; Cashout"
              product="cashout"
              dep={data.cashout.dep}
              wd={data.cashout.wd}
              running={data.cashout.running}
              changeVsOpening={data.cashout.changeVsOpening}
              chartTitle="CashGo Trend"
              chartSubtitle="Daily CashGo volume"
              series={CASHOUT_TREND_SERIES}
              tooltipSeries={CASHOUT_WALLET_SERIES}
              chart={data.cashout.chart}
              chart30={data.cashout.chart30}
              openingTrend={data.cashout.openingTrend}
              wallets={data.cashout.wallets}
              topPerformers={data.topPerformers.cashout}
              agents={data.agents.cashout}
            />

            <ProductBlock
              title="SSP Line 2 &middot; Send Money"
              product="sendmoney"
              dep={data.sendmoney.dep}
              wd={data.sendmoney.wd}
              running={data.sendmoney.running}
              changeVsOpening={data.sendmoney.changeVsOpening}
              chartTitle="Bundle Transfer Trend"
              chartSubtitle="Daily bundle volume"
              series={SENDMONEY_TREND_SERIES}
              tooltipSeries={SENDMONEY_WALLET_SERIES}
              chart={data.sendmoney.chart}
              chart30={data.sendmoney.chart30}
              openingTrend={data.sendmoney.openingTrend}
              wallets={data.sendmoney.wallets}
              topPerformers={data.topPerformers.sendmoney}
              agents={data.agents.sendmoney}
            />

            <section>
              <SectionLabel>Running Balance by Brand</SectionLabel>
              <div className="grid grid-cols-1 gap-[14px] min-[1100px]:grid-cols-2">
                <RunningBalanceByBrandSection
                  rows={data.brandBalance.cashout}
                  title="SSP Line 1: Cashout"
                  subtitle="Smart Solution Running Balance by Brand"
                  exportFileName="SSP_LINE1_AGENT_CASHOUT"
                  exportSheetName="SSP Line 1 Cashout"
                  blankKeys={BLANK_KEYS_CASHOUT}
                />
                <RunningBalanceByBrandSection
                  rows={data.brandBalance.sendmoney}
                  title="SSP Line 2: Send Money"
                  subtitle="Smart Solution Running Balance by Brand"
                  exportFileName="SSP_LINE1_SENDMONEY"
                  exportSheetName="SSP Line 1 Send Money"
                  blankKeys={BLANK_KEYS_SENDMONEY}
                />
              </div>
            </section>

            <section data-telegram-capture="brand">
              <SectionLabel>Brand Balance &middot; Cash In Hand</SectionLabel>
              <CashInHandSection rows={data.cashInHand.rows} total={data.cashInHand.total} />
            </section>
          </>
        )}
        </div>
      </main>
    </div>
  );
}
