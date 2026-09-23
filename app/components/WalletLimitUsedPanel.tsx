'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { Download } from 'lucide-react';
import * as XLSX from 'xlsx';

// "Limit Used" summary panel for the Cashout Wallet Status page — one card
// per wallet type (Bkash/Nagad/Rocket/UPay) showing a usage bar, per-status
// account breakdown (hover tooltip), and a toggle between two exact,
// mutually exclusive status sets (see DEPOSIT_ONLY_STATUSES/
// ALL_WALLETS_STATUSES below) — Top Up Acc./Account Problem wallets count
// toward neither view:
//   - "Deposit Accounts Only" (default): DP + WD, DP Only.
//   - "All Wallets" (toggled on): DP + WD, DP Only, WD Only, Disable,
//     Wallet With Issue, Disconnected — including genuinely logged-out
//     wallets this time (Disconnected is how they enter this view), per
//     explicit instruction.

export type WalletLimitUsedRow = {
  walletType: string;
  dailyLimit: number;
  availableLimit: number;
  walletStatus: string;
};

// Canonical order (data lookups, export rows) — display order is separate,
// see DISPLAY_ORDER below.
const WALLET_TYPES = ['Bkash', 'Nagad', 'Rocket', 'UPay'];

// Same real wallet logos + color-chip fallback as the Dashboard's own
// Wallet Breakdown tiles (WalletLogo in app/page.tsx) — copied locally
// rather than shared/exported, matching this codebase's own convention of
// small per-file helpers over a shared component for something this
// small. Keys are uppercase; this panel's own WALLET_TYPES are title
// case, so lookups go through .toUpperCase().
const WALLET_LOGOS: Record<string, string> = {
  BKASH: '/wallets/Bkash.png',
  NAGAD: '/wallets/Nagad.png',
  ROCKET: '/wallets/Rocket.png',
  UPAY: '/wallets/Upay.png',
};
const WALLET_LOGO_COLORS: Record<string, string> = {
  BKASH: '#E2136E',
  NAGAD: '#F5821F',
  ROCKET: '#8C3494',
  UPAY: '#3EB549',
};

function WalletLogo({ walletType }: { walletType: string }) {
  const [imgError, setImgError] = useState(false);
  const key = walletType.toUpperCase();
  const src = WALLET_LOGOS[key];

  if (!src || imgError) {
    return (
      <div
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-[8px] font-bold text-white"
        style={{ backgroundColor: WALLET_LOGO_COLORS[key] ?? '#94a3b8' }}
      >
        {walletType.charAt(0)}
      </div>
    );
  }

  return (
    <div className="relative h-4 w-4 shrink-0 overflow-hidden rounded-md">
      <Image src={src} alt={walletType} fill sizes="16px" className="object-contain" onError={() => setImgError(true)} />
    </div>
  );
}

// Same hue family as the Balance page's own walletStatusBadgeClasses
// (app/agentbal/page.tsx) — solid dot fills instead of light-bg pills.
// Disconnected never appears here (excluded by the Login=Yes base
// filter), so it has no entry.
const STATUS_DOT_COLOR: Record<string, string> = {
  'DP + WD': '#10B981',
  'DP Only': '#10B981',
  'WD Only': '#F59E0B',
  'Top Up Acc.': '#6366F1',
  'Wallet With Issue': '#F43F5E',
  'Disable': '#F59E0B',
  'Account Problem': '#F43F5E',
};

function usageLevelColors(usedPct: number): { fill: string; track: string; text: string } {
  if (usedPct >= 90) return { fill: 'bg-rose-600', track: 'bg-rose-100 dark:bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400' };
  if (usedPct >= 70) return { fill: 'bg-amber-500', track: 'bg-amber-100 dark:bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' };
  return { fill: 'bg-blue-600', track: 'bg-blue-100 dark:bg-blue-500/15', text: 'text-blue-600 dark:text-blue-400' };
}

// Below 1M, K reads better than a small decimal M (e.g. "750K" instead of
// "0.75M") — per explicit instruction. M stays for anything at/above 1M.
function fmtM(n: number): string {
  if (Math.abs(n) < 1_000_000) {
    return `${Math.round(n / 1000).toLocaleString()}K`;
  }
  return `${(Math.round(n / 10000) / 100).toLocaleString()}M`;
}

type WalletStat = {
  walletType: string;
  total: number;
  avail: number;
  accounts: number;
  reached: number;
  usedPct: number;
  breakdown: { status: string; count: number; remaining: number }[];
};

// Exact, exclusive status sets per toggle state — per explicit
// instruction. Not a superset/subset relationship: Top Up Acc./Account
// Problem wallets count toward neither view. Also doubles as the
// tooltip's own fixed display order for the "All Wallets" state (DP+WD,
// DP Only, WD Only, Disable, Wallet With Issue, Disconnected, in that
// exact sequence — not sorted by count).
const DEPOSIT_ONLY_STATUSES = ['DP + WD', 'DP Only'];
const ALL_WALLETS_STATUSES = ['DP + WD', 'DP Only', 'WD Only', 'Disable', 'Wallet With Issue', 'Disconnected'];

function computeStats(rows: WalletLimitUsedRow[], includeAllStatuses: boolean): Map<string, WalletStat> {
  const activeStatuses = includeAllStatuses ? ALL_WALLETS_STATUSES : DEPOSIT_ONLY_STATUSES;
  const map = new Map<string, WalletStat>();
  for (const type of WALLET_TYPES) {
    // "All Wallets" deliberately does NOT gate on isLoggedIn — that's
    // exactly how a genuinely Disconnected (Login=No) wallet is able to
    // show up in this view at all, via its own listed status.
    const included = rows.filter((r) => r.walletType === type && activeStatuses.includes(r.walletStatus));
    const total = included.reduce((sum, r) => sum + r.dailyLimit, 0);
    const avail = included.reduce((sum, r) => sum + r.availableLimit, 0);
    const reached = included.filter((r) => r.availableLimit <= 0).length;
    const usedPct = total > 0 ? Math.round((1 - avail / total) * 100) : 0;
    const counts = new Map<string, number>();
    const remainingByStatus = new Map<string, number>();
    included.forEach((r) => {
      counts.set(r.walletStatus, (counts.get(r.walletStatus) ?? 0) + 1);
      remainingByStatus.set(r.walletStatus, (remainingByStatus.get(r.walletStatus) ?? 0) + r.availableLimit);
    });
    // Each status's own real availableLimit sum — NOT a proportional split
    // of the group's total avail by account-count share (the prior
    // formula, `avail * count/breakdownCountSum`). That produced a
    // different figure for the exact same DP+WD accounts depending on
    // which other statuses were in the active set (Deposit Only vs All
    // Wallets), since the shared pool it was splitting changed size even
    // though DP+WD's own accounts/limits didn't. Confirmed via real data:
    // DP+WD showed 26.23M remaining in Deposit Only but 22.24M in All
    // Wallets for the same 509 Bkash accounts.
    // "Deposit Accounts Only" always lists both its statuses (DP + WD, DP
    // Only), even a real zero — per explicit instruction, so the operator
    // can tell "confirmed zero open limit" apart from "hidden/unknown"
    // rather than the row just disappearing. "All Wallets" keeps the old
    // zero-count-hidden behavior (6 possible statuses is a lot of rows to
    // show unconditionally).
    const breakdown = activeStatuses
      .filter((status) => includeAllStatuses ? (counts.get(status) ?? 0) > 0 : true)
      .map((status) => {
        const count = counts.get(status) ?? 0;
        return { status, count, remaining: remainingByStatus.get(status) ?? 0 };
      });
    map.set(type, { walletType: type, total, avail, accounts: included.length, reached, usedPct, breakdown });
  }
  return map;
}

function WalletLimitTile({ stat }: { stat: WalletStat }) {
  const c = usageLevelColors(stat.usedPct);
  const availableAccounts = stat.accounts - stat.reached;
  const triggerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Portal-rendered, fixed-position tooltip — this panel sits inside the
  // page's own <main className="overflow-hidden ...">, so a plain
  // absolute-positioned tooltip gets clipped at the bottom the moment it
  // grows taller than the panel itself (confirmed live). Same pattern
  // already established elsewhere on this page for its own tooltips
  // (useToolbarTooltip/useBelowTooltip) — measure the trigger's own
  // bounding rect on hover, render into document.body via createPortal.
  useEffect(() => {
    if (open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
      setRendered(true);
    } else {
      const timeout = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timeout);
    }
  }, [open]);

  return (
    <div
      ref={triggerRef}
      className="relative py-[7px]"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="mb-[4px] flex items-center justify-between gap-[4px]">
        <span className="flex min-w-0 items-center gap-[4px]">
          <WalletLogo walletType={stat.walletType} />
          <p className="truncate text-[11px] font-semibold text-foreground">{stat.walletType}</p>
        </span>
        <span className={`shrink-0 whitespace-nowrap text-[9px] font-semibold ${c.text}`}>{stat.usedPct}% used</span>
      </div>
      <div className={`h-[5px] overflow-hidden rounded-full ${c.track}`}>
        <div className={`h-full rounded-full ${c.fill}`} style={{ width: `${Math.min(stat.usedPct, 100)}%` }} />
      </div>
      <div className="mt-[4px] flex items-center justify-between gap-[4px] whitespace-nowrap text-[9px] font-medium text-muted-foreground">
        <span className="truncate">{fmtM(stat.total)} total</span>
        <span className="truncate">{stat.accounts.toLocaleString()} acc.</span>
        <span className="truncate">{fmtM(stat.avail)} avail.</span>
      </div>

      {rendered && typeof document !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className={`pointer-events-none z-[9999] w-[234px] rounded-xl border border-border bg-white p-[13px] shadow-[0_8px_24px_rgba(20,22,30,0.12)] transition-[opacity,transform] duration-150 ease-out dark:bg-[#2a2a2d] ${open ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'}`}
        >
          <div className="mb-[9px] flex items-center justify-between">
            <span className="text-[13px] font-bold text-foreground">{stat.walletType}</span>
            <span className={`rounded-full px-[9px] py-[2px] text-[10px] font-semibold ${c.track} ${c.text}`}>{stat.usedPct}% used</span>
          </div>
          <p className="mb-[7px] text-[9px] font-medium uppercase tracking-[0.03em] text-muted-foreground">Account Breakdown</p>
          {stat.breakdown.length === 0 && <p className="my-[5px] text-[11px] text-muted-foreground">No accounts in this view.</p>}
          {stat.breakdown.map((b) => (
            <div key={b.status} className="my-[5px] flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-[7px] text-muted-foreground">
                <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: STATUS_DOT_COLOR[b.status] ?? '#9CA3AF' }} />
                {b.status}
                <span className="ml-[2px] rounded-lg bg-muted px-[5px] py-px text-[9px] text-muted-foreground">{b.count.toLocaleString()}</span>
              </span>
              <span className="font-semibold text-foreground">{fmtM(b.remaining)}</span>
            </div>
          ))}
          <div className="my-[9px] border-t border-border" />
          <div className="my-[5px] flex justify-between text-[11px] text-muted-foreground">
            <span>Total Accounts</span><span className="font-semibold text-foreground">{stat.accounts.toLocaleString()}</span>
          </div>
          <div className="my-[5px] flex justify-between text-[11px] text-muted-foreground">
            <span>Available Accounts</span><span className="font-semibold text-foreground">{availableAccounts.toLocaleString()}</span>
          </div>
          <div className="my-[5px] flex justify-between text-[11px] text-muted-foreground">
            <span>Limit Reached Accounts</span><span className="font-semibold text-rose-600 dark:text-rose-400">{stat.reached.toLocaleString()}</span>
          </div>
          <div className="my-[9px] border-t border-border" />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Remaining Limit</span><span className="font-semibold text-blue-600 dark:text-blue-400">{fmtM(stat.avail)}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Loading placeholder for one tile — same layout/dimensions as the real
// WalletLimitTile (logo, title, %used, progress bar, meta row) so nothing
// shifts when real data lands, using the app's universal pulse skeleton
// (`.dt-skeleton`) rather than the static "0M total / 0 acc." zero-values
// the tiles showed during the initial fetch before this was added.
function WalletLimitTileSkeleton() {
  return (
    <div className="py-[7px]">
      <div className="mb-[4px] flex items-center justify-between gap-[4px]">
        <span className="flex min-w-0 items-center gap-[4px]">
          <div className="dt-skeleton h-4 w-4 shrink-0 rounded-md" />
          <div className="dt-skeleton h-[11px] w-12 rounded" />
        </span>
        <div className="dt-skeleton h-[9px] w-10 shrink-0 rounded" />
      </div>
      <div className="dt-skeleton h-[5px] w-full rounded-full" />
      <div className="mt-[4px] flex items-center justify-between gap-[4px]">
        <div className="dt-skeleton h-[9px] w-10 rounded" />
        <div className="dt-skeleton h-[9px] w-8 rounded" />
        <div className="dt-skeleton h-[9px] w-10 rounded" />
      </div>
    </div>
  );
}

export default function WalletLimitUsedPanel({ rows, loading }: { rows: WalletLimitUsedRow[]; loading?: boolean }) {
  const [includeAllStatuses, setIncludeAllStatuses] = useState(false);
  const stats = useMemo(() => computeStats(rows, includeAllStatuses), [rows, includeAllStatuses]);

  const handleExport = () => {
    const viewLabel = includeAllStatuses ? 'All Wallets' : 'Deposit Accounts Only';
    const summaryHeader = ['Wallet', 'Total Limit', 'Available Limit', 'Accounts', 'Limit Reached Accounts', '% Used', 'View'];
    const summaryRows = WALLET_TYPES.map((type) => {
      const s = stats.get(type)!;
      return [s.walletType, s.total, s.avail, s.accounts, s.reached, `${s.usedPct}%`, viewLabel];
    });
    const breakdownHeader = ['Wallet', 'Status', 'Accounts', 'Remaining Limit'];
    const breakdownRows = WALLET_TYPES.flatMap((type) => {
      const s = stats.get(type)!;
      return s.breakdown.map((b) => [s.walletType, b.status, b.count, Math.round(b.remaining)]);
    });
    const worksheet = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows, [], breakdownHeader, ...breakdownRows]);
    worksheet['!cols'] = summaryHeader.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Limit Used');
    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `WALLET_LIMIT_USED_${datePart}_${timePart}.xlsx`);
  };

  return (
    // No outer card/border here anymore — this renders as the top section
    // INSIDE the page's own single DataTable container (merged with the
    // table below it per explicit instruction), not as its own separate
    // bordered box. Export is icon-only, top right corner, matching the
    // icon-only convention used everywhere else (Columns/Refresh) rather
    // than a labeled button. "Available Limit" title + the Deposit
    // Accounts Only toggle both stay on the left per explicit instruction.
    <div className="shrink-0 border-b border-border px-[14px] pb-[10px] pt-[12px] dark:border-[#262B38]">
      <div className="mb-[8px] flex items-center justify-between">
        <div className="flex items-center gap-[10px]">
          <span className="text-[12px] font-semibold text-foreground">Available Limit</span>
          <div className="flex items-center gap-[6px]">
            <span className={`text-[10px] text-muted-foreground ${includeAllStatuses ? 'font-semibold' : 'font-normal'}`}>
              {includeAllStatuses ? 'All Wallets' : 'Deposit Accounts Only'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={includeAllStatuses}
              aria-label="Toggle between deposit accounts only and all active accounts"
              onClick={() => setIncludeAllStatuses((c) => !c)}
              className={`relative h-[17px] w-[31px] shrink-0 rounded-full transition-colors ${includeAllStatuses ? 'bg-blue-600' : 'bg-[#D9DCE3] dark:bg-[#3a3a3d]'}`}
            >
              <span className={`absolute top-[2px] h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-[left] ${includeAllStatuses ? 'left-[16px]' : 'left-[2px]'}`} />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          aria-label="Export Limit Used"
          title="Export Limit Used"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border text-muted-foreground transition-colors hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)]"
        >
          <Download size={12} />
        </button>
      </div>
      {/* Single row of 4 (reverted from a 2x2 grid) — per explicit
          instruction, all four tiles stay on one line so the merged panel
          doesn't grow taller; WalletLimitTile's text was shrunk further to
          keep each quarter-width tile readable without wrapping. */}
      <div className="grid grid-cols-4 gap-[8px]">
        {WALLET_TYPES.map((type) => (
          <div key={type} className="min-w-0 rounded-lg border border-border bg-muted/10 px-[10px] dark:bg-white/[0.02]">
            {loading ? <WalletLimitTileSkeleton /> : <WalletLimitTile stat={stats.get(type)!} />}
          </div>
        ))}
      </div>
    </div>
  );
}
