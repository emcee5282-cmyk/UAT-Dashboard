'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { TrendingUp, TrendingDown, Wallet, Activity, RefreshCw, Download, ChevronUp, ChevronDown } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import ProductSwitchTabs from '../components/ProductSwitchTabs';
import AccountMenu from '../components/AccountMenu';
import EmptyState from '../components/EmptyState';
import ConnectionErrorState from '../components/ConnectionErrorState';
import TrendChart, { type TrendPoint, type TrendSeriesDef } from '../components/TrendChart';
import { getBusinessToday } from '../lib/businessDate';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { clean, fmt, fmtAbbrev, fmtCell } from '../lib/format';
import { parseCsvLines } from '../lib/csv';

const CASHGO_SERIES_DEFS: TrendSeriesDef[] = [
  { key: 'bk', label: 'Bkash' },
  { key: 'ng', label: 'Nagad' },
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// "CashGo" sheet dates are formatted "June 1" (no year).
function parseSheetDate(raw: string): Date | null {
  const match = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = parseInt(match[2], 10);
  return new Date(new Date().getFullYear(), monthIndex, day);
}

type Row = {
  wallet: string;
  totalDP: number;
  totalWD: number;
  bdTransferIn: number;
  stlm: number;
  actualBal: number;
  opening: number;
  runningBal: number;
};

type AgentRow = {
  agentName: string;
  opening: number;
  runningBalance: number;
  totalDP: number;
  balanceInside: number;
};

const RANK_LABELS = ['1st', '2nd', '3rd', '4th'];

const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

// "To Agent" values on "AG BD STLM + TOPUP" sometimes carry a trailing
// "-<brand>" suffix (e.g. "KONAN001-M1") — strip it so the bare code matches
// the Opening sheet's own (always-bare) agent names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// The brand source for the SSP Line 1 (Cashout) table's live Top Up/
// Settlement columns — read directly off the shop name as displayed, e.g.
// "KONAN001-M1" -> "M1" (trailing suffix, the common case). Returns null
// for shops with no such suffix; verified against a real pivot table of the
// underlying sheet that these should be excluded, NOT cross-referenced
// against "SSP AG BalanceLimit" — that cross-reference (this table's
// earlier, pre-restoration version) inflated some brands 50%+ and invented
// figures for brands (K1/B1/B4) the pivot shows as having none at all.
function extractBrandSuffix(name: string): string | null {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  return parts.length >= 2 && BRAND_CODES.includes(last) ? last : null;
}

// A handful of shops use Send Money's own wallet-naming convention instead
// of the common trailing-suffix one above — brand right after the FIRST
// hyphen, as exactly "<code>AG", not the last segment — e.g.
// "T-B5AG-BURMA001-NG" or, with an extra mid-tier code segment,
// "N-K1AG-J3-AVENT001-BK" / "N-M1AG-M4-DAGON002-BK". Segment count varies
// (4 or 5 parts seen live); matched on segment 1 alone, not a fixed length,
// after a length-restricted version was confirmed live to silently drop
// real, current Settlement amounts entirely for every brand.
function extractBrandFromAltFormat(name: string): string | null {
  const segment = (name.split('-')[1] ?? '').toUpperCase();
  return BRAND_CODES.find((code) => segment === `${code}AG`) ?? null;
}

// "AG BD STLM + TOPUP" dates are formatted "M/D/YYYY".
function parseStlmRowDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

// "Brand Balance" sheet writes negative figures in accounting format, e.g.
// "(1,137,336.19)", and a bare "-" for zero — neither parses correctly
// through clean()'s plain parseFloat.
function cleanSigned(val: string): number {
  const raw = (val ?? '').replace(/"/g, '').trim();
  if (!raw || raw === '-') return 0;
  const negative = raw.startsWith('(') && raw.endsWith(')');
  const inner = negative ? raw.slice(1, -1) : raw;
  const num = parseFloat(inner.replace(/,/g, '')) || 0;
  return negative ? -num : num;
}

// Send Money's own brand resolution — unlike Cashout's (which cross-
// references "SSP AG BalanceLimit"'s Group column), Send Money's brand is
// embedded directly in the wallet name itself. Names now carry an extra
// trailing brand tag beyond the older format (e.g. "D-B2BD-DELTA073-NG-B3"
// — the rightmost "B3", not "B2BD"'s "B2", is the real brand), so the
// rightmost segment is checked first; older names without that trailing tag
// (or ones whose trailing segment is something else entirely, e.g. "-SS")
// fall back to the segment right after the first hyphen. Same fix already
// applied to app/sendmoney/settlement/page.tsx and app/sendmoney/topup/
// page.tsx — this table's per-brand Top Up/Settlement totals must resolve
// brand identically to those tabs, or the two disagree on the same money.
// Includes 'SH' (Sharing), a brand Cashout's own roster doesn't have.
const SENDMONEY_BRAND_CODES = [...BRAND_CODES, 'SH'];

function resolveSendMoneyBrandFromWalletName(walletName: string): string {
  const segments = walletName.split('-');
  const last = (segments[segments.length - 1] ?? '').toUpperCase();
  const trailing = SENDMONEY_BRAND_CODES.find((c) => c === last);
  if (trailing) return trailing;
  const afterFirst = (segments[1] ?? '').toUpperCase();
  const code = SENDMONEY_BRAND_CODES.find((c) => afterFirst.startsWith(c));
  return code ?? '−';
}

// Same source/cutoff as the page's own agent-level Top Up/Settlement totals
// below, but grouped by the brand suffix embedded in the shop name itself
// (e.g. "KONAN001-M1" -> "M1") instead of by agent — feeds the SSP Line 1
// (Cashout) table's live Top Up/Settlement columns. Deliberately does NOT
// fall back to cross-referencing "SSP AG BalanceLimit" for shops with no
// suffix (unlike this page's per-agent topUpTotals/stlmTotals below,
// app/topup/page.tsx, or app/agentbal/page.tsx) — verified against a real
// pivot table of the underlying sheet: cross-referencing every unsuffixed
// row inflated some brands 50%+ and invented figures for brands (K1/B1/B4)
// the pivot shows as having none at all. Suffix-only matched the pivot
// exactly for 5 of 7 brands present.
function computeCashoutBrandTopUpStlm(text: string, cutoff: Date): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (brand: string | null, key: 'topUp' | 'stlm', amount: number) => {
    if (!brand) return;
    const existing = totals.get(brand) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(brand, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = parseStlmRowDate((cols[3] ?? '').replace(/"/g, '').trim());
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpDate && topUpDate >= cutoff) {
      add(extractBrandSuffix(topUpAgent) ?? extractBrandFromAltFormat(topUpAgent), 'topUp', topUpAmount);
    }
    const stlmAgent = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = parseStlmRowDate((cols[9] ?? '').replace(/"/g, '').trim());
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmDate && stlmDate >= cutoff) {
      add(extractBrandSuffix(stlmAgent) ?? extractBrandFromAltFormat(stlmAgent), 'stlm', stlmAmount);
    }
  });

  return totals;
}

// Same shape as computeCashoutBrandTopUpStlm, sourced from Send Money's own
// "PS BD STLM + TOPUP" sheet — no cross-sheet Group lookup needed since the
// wallet name itself carries the brand (resolveSendMoneyBrandFromWalletName).
function computeSendMoneyBrandTopUpStlm(text: string, cutoff: Date): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (brand: string, key: 'topUp' | 'stlm', amount: number) => {
    if (brand === '−') return;
    const existing = totals.get(brand) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(brand, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpName = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = parseStlmRowDate((cols[3] ?? '').replace(/"/g, '').trim());
    if (topUpName && topUpName !== '-' && topUpAmount && topUpDate && topUpDate >= cutoff) {
      add(resolveSendMoneyBrandFromWalletName(topUpName), 'topUp', topUpAmount);
    }
    const stlmName = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = parseStlmRowDate((cols[9] ?? '').replace(/"/g, '').trim());
    if (stlmName && stlmName !== '-' && stlmAmount && stlmDate && stlmDate >= cutoff) {
      add(resolveSendMoneyBrandFromWalletName(stlmName), 'stlm', stlmAmount);
    }
  });

  return totals;
}

type SspLine1Row = {
  brand: string;
  opening: number;
  deposit: number;
  withdrawal: number;
  topUp: number;
  settlement: number;
  total: number;
};

// "Brand Balance!B3:G13" (Cashout) / "Brand Balance!B16:G26" (Send Money):
// row 0 is the header (Brand, Opening Balance, Deposit, Withdrawal,
// Adjustment, Total), remaining rows are one per brand (M1/M2/K1/B1-B5/T1/
// J1) — no footer row. Column D (Adjustment, index 4) is intentionally not
// read — replaced by live per-brand Top Up/Settlement (see
// computeCashoutBrandTopUpStlm/computeSendMoneyBrandTopUpStlm above), merged
// in by the caller.
function parseSspLine1(text: string): Omit<SspLine1Row, 'topUp' | 'settlement'>[] {
  const toRow = (cols: string[]): Omit<SspLine1Row, 'topUp' | 'settlement'> => ({
    brand: (cols[0] ?? '').replace(/"/g, '').trim(),
    opening: cleanSigned(cols[1]),
    deposit: cleanSigned(cols[2]),
    withdrawal: cleanSigned(cols[3]),
    total: cleanSigned(cols[5]),
  });

  return text.trim().split('\n').slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => toRow(line.split(',')));
}

const SSP_LINE1_COLUMNS: { key: keyof Omit<SspLine1Row, 'brand'>; label: string }[] = [
  { key: 'opening', label: 'Opening Balance' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'withdrawal', label: 'Withdrawal' },
  { key: 'topUp', label: 'Top Up' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'total', label: 'Total' },
];

// Zero reads as neutral (muted, no sign); everything else gets a "−" prefix
// when negative, plain otherwise — no "+" prefix (unlike the Wallet
// Summary's own flowValueDisplay), since these are balances, not deltas.
function sspLine1ValueDisplay(value: number): { text: string; className: string } {
  const zero = Math.abs(value) < 0.005;
  const negative = value < 0;
  return {
    text: zero ? '−' : `${negative ? '−' : ''}${fmt(value)}`,
    className: zero ? 'text-muted-foreground' : negative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
  };
}

function SspLine1ValueCell({ value, bold }: { value: number; bold?: boolean }) {
  const display = sspLine1ValueDisplay(value);
  return (
    <td className={`whitespace-nowrap px-4 py-3 text-center text-[13px] tabular-nums ${bold ? 'font-bold' : 'font-medium'} ${display.className}`}>
      {display.text}
    </td>
  );
}

type SspLine1SortKey = keyof SspLine1Row;

// Chevron pair when idle, single filled chevron when this column is the
// active sort — same visual convention as the sort arrows used elsewhere in
// the app (e.g. app/agentbal/page.tsx's own SortIcon).
function SspLine1SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
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

function SspLine1Section({
  rows,
  title,
  subtitle,
  exportFileName,
  exportSheetName,
}: {
  rows: SspLine1Row[];
  title: string;
  subtitle: string;
  exportFileName: string;
  exportSheetName: string;
}) {
  // No default sort — first click on a column sorts highest-to-lowest
  // (desc), second click toggles to lowest-to-highest (asc), third click
  // returns to the unsorted default.
  const [sortColumn, setSortColumn] = useState<SspLine1SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleHeaderClick = useCallback((key: SspLine1SortKey) => {
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

  // Column sums across every brand — always the full unsorted set (a footer
  // total shouldn't reorder with the rows above it), pinned at the bottom
  // regardless of sort state, same convention as the Wallet Summary table's
  // own Total row.
  const totals = useMemo(
    () => SSP_LINE1_COLUMNS.reduce((acc, col) => {
      acc[col.key] = rows.reduce((sum, row) => sum + row[col.key], 0);
      return acc;
    }, {} as Record<keyof Omit<SspLine1Row, 'brand'>, number>),
    [rows]
  );

  const handleExport = useCallback(() => {
    const headers = ['Brand', ...SSP_LINE1_COLUMNS.map((c) => c.label)];
    const data = rows.map((row) => [row.brand, ...SSP_LINE1_COLUMNS.map((c) => row[c.key])]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, exportSheetName);

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `${exportFileName}_${datePart}_${timePart}.xlsx`);
  }, [rows, exportFileName, exportSheetName]);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Wallet size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-foreground">{title}</h2>
            <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[14px] font-medium text-white hover:bg-indigo-700"
        >
          <Download size={13} />
          Export
        </button>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold text-muted-foreground">
                <button type="button" onClick={() => handleHeaderClick('brand')} className="flex items-center gap-1 hover:opacity-80">
                  Brand
                  <SspLine1SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </th>
              {SSP_LINE1_COLUMNS.map((col) => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-center text-[12px] font-semibold text-muted-foreground">
                  <button type="button" onClick={() => handleHeaderClick(col.key)} className="flex w-full items-center justify-center gap-1 hover:opacity-80">
                    {col.label}
                    <SspLine1SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length > 0 ? sortedRows.map((row) => (
              <tr key={row.brand} className="border-b border-border last:border-0 transition-colors hover:bg-muted/10">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[13px] font-semibold text-foreground">{row.brand}</td>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <SspLine1ValueCell key={col.key} value={row[col.key]} bold={col.key === 'total'} />
                ))}
              </tr>
            )) : (
              <tr>
                <td colSpan={SSP_LINE1_COLUMNS.length + 1}>
                  <EmptyState title="No brand data available" description="Brand balance data hasn't loaded for this period yet." />
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/20">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[13px] font-bold text-foreground">Total</td>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <SspLine1ValueCell key={col.key} value={totals[col.key]} bold />
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile: one card per brand — same "card list" pattern as the
          Wallet Summary table's own mobile fallback. */}
      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.length > 0 ? sortedRows.map((row) => {
          const totalDisplay = sspLine1ValueDisplay(row.total);
          return (
            <div key={row.brand} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
                {SSP_LINE1_COLUMNS.filter((col) => col.key !== 'total').map((col) => {
                  const display = sspLine1ValueDisplay(row[col.key]);
                  return (
                    <div key={col.key} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{col.label}</p>
                      <p className={`mt-0.5 text-[10.5px] font-semibold tabular-nums ${display.className}`}>{display.text}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }) : (
          <EmptyState title="No brand data available" description="Brand balance data hasn't loaded for this period yet." />
        )}
        {rows.length > 0 && (() => {
          const totalDisplay = sspLine1ValueDisplay(totals.total);
          return (
            <div className="rounded-xl border-2 border-border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">Total</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
                {SSP_LINE1_COLUMNS.filter((col) => col.key !== 'total').map((col) => {
                  const display = sspLine1ValueDisplay(totals[col.key]);
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

// Mirrors the real table's own markup/padding (10 brand rows + header, no
// footer) instead of a handful of generic placeholder lines — a shorter
// fake table would cause a visible size jump when the real table pops in.
function SspLine1Skeleton() {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
          <div>
            <div className="h-[20px] w-48 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            <div className="mt-1.5 h-[16px] w-64 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
          </div>
        </div>
        <div className="h-8 w-24 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10" style={{ height: '42.5px' }}>
              <th className="px-4 py-3 text-left">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </th>
              {SSP_LINE1_COLUMNS.map((col) => (
                <th key={col.key} className="px-4 py-3">
                  <div className="mx-auto h-3 w-14 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0" style={{ height: '44.5px' }}>
                <td className="px-4 py-3">
                  <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                </td>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/20" style={{ height: '44.5px' }}>
              <td className="px-4 py-3">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </td>
              {SSP_LINE1_COLUMNS.map((col) => (
                <td key={col.key} className="px-4 py-3">
                  <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]" style={{ height: '184px' }}>
            <div className="flex items-start justify-between gap-2">
              <div className="h-[18px] w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                <div className="h-[22px] w-24 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
              {Array.from({ length: 4 }).map((__, j) => (
                <div key={j} className="min-w-0">
                  <div className="h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  <div className="mt-1.5 h-3 w-14 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="rounded-xl border-2 border-border bg-muted/20 p-4" style={{ height: '186px' }}>
          <div className="flex items-start justify-between gap-2">
            <div className="h-[18px] w-20 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
            <div className="flex flex-col items-end gap-1.5">
              <div className="h-3 w-16 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              <div className="h-[22px] w-24 animate-pulse rounded-md bg-slate-400 dark:bg-slate-500" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
            {Array.from({ length: 4 }).map((__, j) => (
              <div key={j} className="min-w-0">
                <div className="h-2.5 w-16 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                <div className="mt-1.5 h-3 w-14 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type WalletColumnKey = 'wallet' | 'totalDP' | 'totalWD' | 'bdTransferIn' | 'stlm' | 'actualBal' | 'runningBal';

const walletColumns: { key: WalletColumnKey; label: string }[] = [
  { key: 'wallet', label: 'Wallet' },
  { key: 'totalDP', label: 'Total DP' },
  { key: 'totalWD', label: 'Total WD' },
  { key: 'bdTransferIn', label: 'Bundle Transfer' },
  { key: 'stlm', label: 'Settlement' },
  { key: 'actualBal', label: 'Actual Balance' },
  { key: 'runningBal', label: 'Running Balance' },
];

export default function Dashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const searchTerm = '';
  const [openingTotal, setOpeningTotal] = useState(0);
  const [agentRows, setAgentRows] = useState<AgentRow[]>([]);
  const [cashGoWeekData, setCashGoWeekData] = useState<TrendPoint[]>([]);
  const [cashGoMonthData, setCashGoMonthData] = useState<TrendPoint[]>([]);
  const [sspLine1CashoutRows, setSspLine1CashoutRows] = useState<SspLine1Row[]>([]);
  const [sspLine1SendMoneyRows, setSspLine1SendMoneyRows] = useState<SspLine1Row[]>([]);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);
      const [res, openingRes, agentBalRes, stlmRes, cashGoRes, sendMoneyStlmRes, sspLine1Res, sspLine1SendMoneyRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/cashgo?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/brand-ssp-line1?t=${Date.now()}`),
        fetch(`/api/brand-ssp-line1-sendmoney?t=${Date.now()}`),
      ]);
      await assertAllOk([res, openingRes, agentBalRes, stlmRes, cashGoRes, sendMoneyStlmRes, sspLine1Res, sspLine1SendMoneyRes]);
      const text = await res.text();
      const openingText = await openingRes.text();
      const agentBalText = await agentBalRes.text();
      const stlmText = await stlmRes.text();
      const cashGoText = await cashGoRes.text();
      const sendMoneyStlmText = await sendMoneyStlmRes.text();
      const sspLine1Text = await sspLine1Res.text();
      const sspLine1SendMoneyText = await sspLine1SendMoneyRes.text();
      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const cols = line.split(',');
          const totalDP = clean(cols[1]);
          const totalWD = clean(cols[2]);
          const bdTransferIn = clean(cols[3]);
          const stlm = clean(cols[4]);
          const opening = clean(cols[7]);
          return {
            wallet: cols[0]?.replace(/"/g, '').trim(),
            totalDP,
            totalWD,
            bdTransferIn,
            stlm,
            actualBal: clean(cols[5]),
            opening,
            runningBal: opening + totalDP + totalWD + bdTransferIn + stlm,
          };
        });

      const openingSum = openingText
        .trim()
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '')
        .reduce((sum, line) => {
          const raw = line.split(',')[1]?.replace(/"/g, '').trim();
          if (!raw || raw === '-') return sum;
          const value = parseFloat(raw.replace(/,/g, ''));
          if (isNaN(value)) return sum;
          return sum + value;
        }, 0);

      console.log('Total Opening Balance sum:', openingSum);

      const openingRawRows = parseCsvLines(openingText);
      // Top Up/Settlement totals reset at the 2AM business-day rollover
      // (see app/lib/businessDate.ts) — clock-based, not gated on whether
      // Opening's own "Updated Time" card has been manually refreshed yet.
      const reportCutoffDate = getBusinessToday();

      const openingAgentRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: (row[0] ?? '').replace(/"/g, '').trim(),
          openingBal: (row[1] ?? '').replace(/"/g, '').trim(),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      const agentTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      // wallet-type level DP/WD from Balance Limit data — col[4]=walletType, col[11]=DP, col[13]=WD
      const walletDPTotals = new Map<string, number>();
      const walletWDTotals = new Map<string, number>();
      parseCsvLines(agentBalText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const name = (row[1] ?? '').replace(/"/g, '').trim();
          if (!name || name === '-') return;
          const dp = clean(row[11]);
          const wd = clean(row[13]);
          const existing = agentTotals.get(name) ?? { dp: 0, wd: 0 };
          agentTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

          // aggregate by wallet type for the Wallet Summary table
          const wType = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (wType && wType !== '-') {
            walletDPTotals.set(wType, (walletDPTotals.get(wType) ?? 0) + dp);
            walletWDTotals.set(wType, (walletWDTotals.get(wType) ?? 0) + wd);
          }

          const login = (row[15] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (login === 'yes') {
            balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + clean(row[8]));
          }
        });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      const walletTopUpTotals = new Map<string, number>();
      const walletStlmTotals = new Map<string, number>();

      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          // Top Up section (cols B-F = 1-5): col[1]=agent, col[2]=amount, col[3]=date, col[4]=wallet
          const topUpAmountNum = clean((row[2] ?? '').replace(/"/g, '').trim());
          const topUpAgent = stripBrandSuffix((row[1] ?? '').replace(/"/g, '').trim());
          const topUpDate = reportCutoffDate ? parseStlmRowDate((row[3] ?? '').replace(/"/g, '').trim()) : null;
          const topUpInRange = !reportCutoffDate || (topUpDate !== null && topUpDate >= reportCutoffDate);
          if (topUpAgent && topUpAgent !== '-' && topUpAmountNum && topUpInRange) {
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + topUpAmountNum);
          }
          // wallet-level top up — col[4] = wallet brand
          const tuWallet = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (tuWallet && tuWallet !== '-' && topUpAmountNum && topUpInRange) {
            walletTopUpTotals.set(tuWallet, (walletTopUpTotals.get(tuWallet) ?? 0) + topUpAmountNum);
          }

          // Settlement section (cols H-L = 7-11): col[7]=agent, col[8]=amount (stored
          // negative, abs()'d below), col[9]=date, col[10]=wallet
          const stlmAgent = stripBrandSuffix((row[7] ?? '').replace(/"/g, '').trim());
          const stlmAmountNum = Math.abs(clean((row[8] ?? '').replace(/"/g, '').trim()));
          const stlmDate = reportCutoffDate ? parseStlmRowDate((row[9] ?? '').replace(/"/g, '').trim()) : null;
          const stlmInRange = !reportCutoffDate || (stlmDate !== null && stlmDate >= reportCutoffDate);
          if (stlmAgent && stlmAgent !== '-' && stlmAmountNum && stlmInRange) {
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + stlmAmountNum);
          }
          // wallet-level settlement — col[10] = wallet brand (Bkash/Nagad/etc.)
          const stlmWallet = (row[10] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (stlmWallet && stlmWallet !== '-' && stlmAmountNum && stlmInRange) {
            walletStlmTotals.set(stlmWallet, (walletStlmTotals.get(stlmWallet) ?? 0) + stlmAmountNum);
          }
        });

      // Patch wallet summary rows — all values from Balance Limit / stlm data
      parsed.forEach((row) => {
        const key = row.wallet.toLowerCase();
        const computedDP  = walletDPTotals.get(key) ?? 0;
        const computedWD  = walletWDTotals.get(key) ?? 0;
        const computedTopUp = walletTopUpTotals.get(key) ?? 0;
        const computedStlm  = walletStlmTotals.get(key) ?? 0;
        if (computedDP)  row.totalDP = computedDP;
        if (computedWD)  row.totalWD = -computedWD;   // WD is stored as positive, display as negative
        if (computedTopUp) row.bdTransferIn = computedTopUp;
        if (computedStlm)  row.stlm = -computedStlm;  // Settlement is stored as positive, display as negative
        row.runningBal = row.opening + row.totalDP + row.totalWD + row.bdTransferIn + row.stlm;
      });

      const mergedAgentRows: AgentRow[] = openingAgentRows.map((agent) => {
        const totals = agentTotals.get(agent.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(agent.agentName) ?? 0;
        const totalStlm = stlmTotals.get(agent.agentName) ?? 0;
        const opening = clean(agent.openingBal);
        return {
          agentName: agent.agentName,
          opening,
          runningBalance: opening + totals.dp + totalTopUp - totals.wd - totalStlm,
          totalDP: totals.dp,
          balanceInside: balanceInsideTotals.get(agent.agentName) ?? 0,
        };
      });

      // CashGo Trend — daily Bkash/Nagad amounts, last 7/30 days. The sheet's
      // own quota columns are no longer used (money values only now, no
      // percentage-of-quota concept). Rows with an unparseable date (e.g. the
      // sheet's own blank template rows for future dates) are dropped.
      const cashGoByDate = new Map<string, { bk: number; ng: number }>();
      parseCsvLines(cashGoText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const dateObj = parseSheetDate((row[1] ?? '').replace(/"/g, '').trim());
          if (!dateObj) return;
          cashGoByDate.set(dateObj.toDateString(), { bk: clean(row[4]), ng: clean(row[5]) });
        });

      const toCashGoPoint = (d: Date): TrendPoint => {
        const totals = cashGoByDate.get(d.toDateString()) ?? { bk: 0, ng: 0 };
        return {
          day: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
          tooltipLabel: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          total: totals.bk + totals.ng,
          series: { bk: totals.bk, ng: totals.ng },
        };
      };

      // Today's data is partial/in-progress, so it's excluded entirely — both
      // windows are full days of history ending yesterday. "Today" here is
      // the 2AM-rollover business date (getBusinessToday), not the literal
      // calendar day — e.g. at 12:38 AM this still resolves to yesterday.
      const now = getBusinessToday();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      const weekHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 6);
      const cashGoWeekPoints: TrendPoint[] = Array.from({ length: 7 }, (_, i) =>
        toCashGoPoint(new Date(weekHistoryStart.getFullYear(), weekHistoryStart.getMonth(), weekHistoryStart.getDate() + i))
      );

      const monthHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 29);
      const cashGoMonthPoints: TrendPoint[] = Array.from({ length: 30 }, (_, i) =>
        toCashGoPoint(new Date(monthHistoryStart.getFullYear(), monthHistoryStart.getMonth(), monthHistoryStart.getDate() + i))
      );

      // SSP Line 1 (Cashout) / SSP Line 2 (Send Money) — "Brand Balance"
      // sheet's own Opening/Deposit/Withdrawal/Total per brand, with Top Up/
      // Settlement replaced by live per-brand totals (same convention as the
      // Wallet Summary table's own bdTransferIn/stlm patch above, just
      // grouped by brand instead of by wallet).
      const cashoutBrandTopUpStlm = computeCashoutBrandTopUpStlm(stlmText, reportCutoffDate);
      setSspLine1CashoutRows(
        parseSspLine1(sspLine1Text).map((row) => {
          const brandTotals = cashoutBrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
          return { ...row, topUp: brandTotals.topUp, settlement: -brandTotals.stlm };
        })
      );

      const sendMoneyBrandTopUpStlm = computeSendMoneyBrandTopUpStlm(sendMoneyStlmText, reportCutoffDate);
      setSspLine1SendMoneyRows(
        parseSspLine1(sspLine1SendMoneyText).map((row) => {
          const brandTotals = sendMoneyBrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
          const settlement = -brandTotals.stlm;
          // Total is computed live here (Cashout's own Total, above, is left
          // reading the "Brand Balance" sheet's own static column — its brand
          // attribution never changed, so it still reconciles). Send Money's
          // static Total predates the brand-basis fix (rightmost-segment) and
          // no longer agrees with the live per-brand Top Up/Settlement split
          // it produces — confirmed live: only 2 of 10 brands still matched
          // the static value. Recomputed instead of trusted from the sheet.
          return { ...row, topUp: brandTotals.topUp, settlement, total: row.opening + row.deposit - row.withdrawal + brandTotals.topUp + settlement };
        })
      );

      setRows(parsed);
      setOpeningTotal(openingSum);
      setAgentRows(mergedAgentRows);
      setCashGoWeekData(cashGoWeekPoints);
      setCashGoMonthData(cashGoMonthPoints);
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const dataRows = rows.filter((r) => r.wallet && r.wallet.toLowerCase() !== 'total');
  const totalRow = rows.find((r) => r.wallet.toLowerCase() === 'total');
  const filteredRows = dataRows.filter((row) => {
    const haystack = `${row.wallet} ${row.actualBal} ${row.runningBal} ${row.totalDP} ${row.totalWD}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  // Sum from wallet summary rows (now sourced from Balance Limit data)
  const totalDPSum  = dataRows.reduce((sum, row) => sum + row.totalDP, 0);
  const totalWDSum  = dataRows.reduce((sum, row) => sum + Math.abs(row.totalWD), 0);
  const runningBalTotal = dataRows.reduce((sum, row) => sum + row.runningBal, 0);
  const runningVsOpening = runningBalTotal - openingTotal;
  // The sheet's own "Total" row can drift from a straight sum of the wallet
  // rows actually shown (confirmed wrong for Running Balance) — the Wallet
  // Summary footer sums the displayed rows directly instead of trusting it,
  // same as every KPI card above already does.
  const bdTransferInSum = dataRows.reduce((sum, row) => sum + row.bdTransferIn, 0);
  const stlmSum = dataRows.reduce((sum, row) => sum + row.stlm, 0);
  // Signed (not abs'd like totalWDSum above) so the footer's "-" prefix
  // matches how each individual wallet row displays Total WD.
  const totalWDSignedSum = dataRows.reduce((sum, row) => sum + row.totalWD, 0);

  const top50Agents = agentRows
    .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
    .sort((a, b) => (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
    .slice(0, 50);

  const walletGainRanking = dataRows
    .map((row) => ({ wallet: row.wallet, gain: row.totalDP + row.totalWD, actualBal: row.actualBal }))
    .sort((a, b) => a.gain - b.gain);

  const actualBalTotal = dataRows.reduce((sum, row) => sum + row.actualBal, 0);

  const summaryCards: Array<{
    label: string;
    bigValue: string;
    bigNegative: boolean;
    subAmount: string;
    subSuffix?: string;
    subPositive: boolean;
    showArrow?: boolean;
  }> = totalRow
    ? [
        {
          label: 'Total Deposit',
          bigValue: fmtAbbrev(totalDPSum),
          bigNegative: false,
          subAmount: fmt(totalDPSum),
          subPositive: true,
        },
        {
          label: 'Total Withdrawal',
          bigValue: fmtAbbrev(totalWDSum),
          bigNegative: false,
          subAmount: fmt(totalWDSum),
          subPositive: false,
        },
        {
          label: 'Actual Balance',
          bigValue: fmtAbbrev(actualBalTotal),
          bigNegative: actualBalTotal < 0,
          subAmount: fmt(actualBalTotal),
          subPositive: actualBalTotal >= 0,
        },
        {
          label: 'Running Balance',
          bigValue: fmtAbbrev(runningBalTotal),
          bigNegative: runningBalTotal < 0,
          subAmount: fmt(runningVsOpening),
          subSuffix: 'vs opening',
          subPositive: runningVsOpening >= 0,
          showArrow: true,
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <PageHeader
        title="Dashboard: SSP Line 1"
        description="Smart Solution Cashout Operations Overview"
        containerless
        centerSlot={
          <div className="inline-flex items-center gap-7 rounded-lg border border-border/70 bg-muted px-4 py-1.5">
            <ProductSwitchTabs />
          </div>
        }
        actions={
          <>
            <button
              onClick={fetchData}
              disabled={spinning}
              aria-label="Refresh"
              title="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/60 text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
            </button>
            <AccountMenu />
          </>
        }
      />

      <main className="space-y-4 px-3 pt-4 pb-5 md:px-6 md:pt-5 md:pb-6">
        {loading && (
          <>
            <div className="relative flex flex-col gap-4 lg:flex-row">
              <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-356px)] lg:flex-none">

                {/* KPI cards skeleton — mirrors: accent bar + icon badge + label + big value + sub */}
                <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-2xl border border-border bg-white p-4 shadow-sm dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="h-2.5 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        <div className="h-7 w-7 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                      </div>
                      <div className="mt-3 h-7 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-2.5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))}
                </section>

                {/* CashGo Trend skeleton — mirrors the real TrendChart: single bordered
                    header (title+period-toggle row, then legend row), 200px chart
                    (chartHeight override — this page runs more compact than the
                    default 280px used elsewhere TrendChart is rendered) */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="h-4 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="h-7 w-24 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                    </div>
                    <div className="mt-2 flex items-center gap-4">
                      <div className="h-3 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="h-3 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  </div>
                  <div className="h-[200px] px-3 py-4 pt-6">
                    <div className="h-full w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
                  </div>
                </section>

                {/* Wallet Summary skeleton — mirrors: header / right-aligned table / alternating rows */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="border-b border-border px-4 py-3">
                    <div className="h-4 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[700px]">
                      <thead>
                        <tr className="border-b border-border bg-muted/30">
                          {walletColumns.map((col, ci) => (
                            <th key={col.key} className="px-4 py-2.5">
                              <div className={`h-2.5 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 ${ci === 0 ? '' : 'ml-auto'}`} />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: 4 }).map((_, ri) => (
                          <tr key={ri} className={`border-b border-border last:border-0 ${ri % 2 === 1 ? 'bg-muted/10' : ''}`}>
                            <td className="px-4 py-3">
                              <div className="h-3 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                            </td>
                            {walletColumns.slice(1).map((col) => (
                              <td key={col.key} className="px-4 py-3">
                                <div className="ml-auto h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <SspLine1Skeleton />
                <SspLine1Skeleton />
              </div>

              <aside className="flex flex-col gap-5 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[340px]">

                {/* Top Performer Wallet skeleton — mirrors: header+label / circle badge + name/sub + value */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="h-4 w-36 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0">
                        <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="h-2 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                        <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      </div>
                    ))}
                  </div>
                </section>

                {/* High Volume Agents skeleton — mirrors: header+badge / circle rank + name/inside + balance/diff */}
                <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d] lg:max-h-none lg:min-h-0 lg:flex-1">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="h-4 w-36 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-5 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className={`flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0 ${i < 3 ? 'bg-muted/20' : ''}`}>
                        <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="h-2 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                        <div className="shrink-0 space-y-1.5 text-right">
                          <div className="ml-auto h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="ml-auto h-2 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && (
          <>
            <div className="relative flex flex-col gap-4 lg:flex-row">
              <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-356px)] lg:flex-none">
                <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {summaryCards.map((card, i) => {
                    const themes = [
                      { Icon: TrendingUp,   iconBg: 'bg-emerald-50 dark:bg-emerald-500/10', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                      { Icon: TrendingDown, iconBg: 'bg-rose-50 dark:bg-rose-500/10',       iconColor: 'text-rose-500 dark:text-rose-400'       },
                      { Icon: Wallet,       iconBg: 'bg-indigo-50 dark:bg-indigo-500/10',   iconColor: 'text-indigo-600 dark:text-indigo-400'   },
                      { Icon: Activity,     iconBg: 'bg-amber-50 dark:bg-amber-500/10',     iconColor: 'text-amber-600 dark:text-amber-400'     },
                    ];
                    const { Icon, iconBg, iconColor } = themes[i] ?? themes[0];
                    return (
                      <div key={card.label} className="rounded-2xl border border-[#e5e5e7] bg-white p-4 shadow-sm hover:shadow-md dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{card.label}</span>
                          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
                            <Icon size={13} className={iconColor} />
                          </div>
                        </div>
                        <p className={`mt-2.5 text-[26px] font-bold leading-none tracking-tight ${card.bigNegative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                          {card.bigNegative ? '-' : ''}{card.bigValue}
                        </p>
                        <div className={`mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] font-medium ${card.subPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                          {card.showArrow && <span className="whitespace-nowrap">{card.subPositive ? '▲' : '▼'}</span>}
                          <span className="whitespace-nowrap tabular-nums">{card.subAmount}</span>
                          {card.subSuffix && <span className="whitespace-nowrap font-normal opacity-80">{card.subSuffix}</span>}
                        </div>
                      </div>
                    );
                  })}
                </section>

                <TrendChart title="CashGo Trend" seriesDefs={CASHGO_SERIES_DEFS} weekData={cashGoWeekData} monthData={cashGoMonthData} chartHeight={200} />

                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="border-b border-border px-4 py-3">
                    <h2 className="text-[13px] font-semibold text-foreground">Wallet Summary</h2>
                  </div>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full min-w-[700px]">
                      <thead>
                        <tr className="h-[48px] border-b border-border bg-muted/30">
                          {walletColumns.map((col) => (
                            <th key={col.key} className="whitespace-nowrap px-4 text-right text-[13px] font-semibold text-[#475569] first:text-left dark:text-[#9CA3AF]">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                          <tr key={row.wallet} className={`border-b border-border last:border-0 hover:bg-muted/30 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                            <td className="whitespace-nowrap px-4 py-3 text-left">
                              <span className="text-xs font-bold text-foreground">{row.wallet}</span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              {fmtCell(row.totalDP)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-medium text-rose-600 dark:text-rose-400">
                              {fmtCell(row.totalWD, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs text-foreground">
                              {fmtCell(row.bdTransferIn)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs text-foreground">
                              {fmtCell(row.stlm, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-medium text-foreground">
                              {fmtCell(row.actualBal)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right">
                              {/* Actual Balance is the reference — its td keeps the browser's
                                  default vertical-align (centered as a single line). This block
                                  is 2 lines, so centering it as a whole leaves the top (black)
                                  figure sitting above that center; translateY nudges the whole
                                  block down by the measured offset so the black figure lines up
                                  with Actual Balance, without touching Actual Balance itself. */}
                              <div style={{ transform: 'translateY(8.25px)' }}>
                                <div className={`tabular-nums text-xs font-bold ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                                  {fmtCell(row.runningBal, true)}
                                </div>
                                <div className={`mt-0.5 tabular-nums text-[10px] font-medium ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                  {row.runningBal >= row.opening ? '▲' : '▼'} {fmtCell(row.runningBal - row.opening)}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan={7}>
                              <EmptyState
                                title="No wallet data available"
                                description="Wallet summary data hasn't loaded for this period yet."
                              />
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {totalRow && (
                        <tfoot>
                          <tr className="border-t-2 border-border bg-muted/20">
                            <td className="whitespace-nowrap px-4 py-3 text-left">
                              <span className="text-xs font-bold text-foreground">Total</span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-bold text-foreground">
                              {fmtCell(totalDPSum)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-bold text-foreground">
                              {fmtCell(totalWDSignedSum, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-bold text-foreground">
                              {fmtCell(bdTransferInSum)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-bold text-foreground">
                              {fmtCell(stlmSum, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-xs font-bold text-foreground">
                              {fmtCell(actualBalTotal)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right">
                              <div style={{ transform: 'translateY(8.25px)' }}>
                                <div className="tabular-nums text-xs font-bold text-foreground">
                                  {fmtCell(runningBalTotal, true)}
                                </div>
                                <div className={`mt-0.5 tabular-nums text-[10px] font-medium ${runningBalTotal >= openingTotal ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                  {runningBalTotal >= openingTotal ? '▲' : '▼'} {fmtCell(runningVsOpening)}
                                </div>
                              </div>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  <div className="flex flex-col gap-3 p-4 sm:hidden">
                    {filteredRows.length > 0 ? filteredRows.map((row) => (
                      <div key={row.wallet} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[15px] font-bold text-foreground">{row.wallet}</span>
                          <div className="text-right">
                            <div className={`text-lg font-bold tabular-nums ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {fmtCell(row.runningBal, true)}
                            </div>
                            <div className={`mt-0.5 text-[11px] font-medium tabular-nums ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {row.runningBal >= row.opening ? '↗' : '↘'} {fmtCell(row.runningBal - row.opening)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total DP</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCell(row.totalDP)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total WD</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-rose-600 dark:text-rose-400">{fmtCell(row.totalWD, true)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Actual Balance</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.actualBal)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Bundle Transfer</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.bdTransferIn)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Settlement</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.stlm, true)}</p>
                          </div>
                        </div>
                      </div>
                    )) : (
                      <EmptyState
                        title="No wallet data available"
                        description="Wallet summary data hasn't loaded for this period yet."
                      />
                    )}
                    {totalRow && (
                      <div className="rounded-xl border-2 border-border bg-muted/20 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[15px] font-bold text-foreground">Total</span>
                          <div className="text-right">
                            <div className="text-lg font-bold tabular-nums text-foreground">
                              {fmtCell(runningBalTotal, true)}
                            </div>
                            <div className={`mt-0.5 text-[11px] font-medium tabular-nums ${runningBalTotal >= openingTotal ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {runningBalTotal >= openingTotal ? '↗' : '↘'} {fmtCell(runningVsOpening)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total DP</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(totalDPSum)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total WD</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(totalWDSignedSum, true)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Actual Balance</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(actualBalTotal)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Bundle Transfer</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(bdTransferInSum)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Settlement</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(stlmSum, true)}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              <aside className="flex flex-col gap-5 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[340px]">
                <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                    <h2 className="text-[13px] font-semibold text-slate-900 dark:text-white">Top Performer Wallet</h2>
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">Net P&amp;L</span>
                  </div>
                  <div>
                    {walletGainRanking.map((item, index) => {
                      const badgeStyle = ([
                        'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-400',
                        'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
                        'bg-orange-100 text-orange-600 dark:bg-orange-400/20 dark:text-orange-400',
                        'bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                      ] as const)[index] ?? 'bg-slate-50 text-slate-400';
                      return (
                        <div
                          key={item.wallet}
                          className={`flex items-center gap-3 border-b border-[#e5e5e7] px-4 py-3.5 last:border-0 dark:border-[#3a3a3d] ${
                            index === 0 ? 'bg-rose-50/70 dark:bg-rose-500/5' : ''
                          }`}
                        >
                          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${badgeStyle}`}>
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-white">{item.wallet}</p>
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">Bal: {fmtCell(item.actualBal, true)}</p>
                          </div>
                          <span className={`shrink-0 text-[12px] font-bold tabular-nums ${
                            item.gain < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
                          }`}>
                            {fmtCell(item.gain, true)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d] lg:max-h-none lg:min-h-0 lg:flex-1">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="text-[13px] font-semibold text-foreground">High Volume Agents</h2>
                    <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
                      Top {top50Agents.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {top50Agents.length > 0 ? top50Agents.map((agent, index) => {
                      const diff = agent.runningBalance - agent.opening;
                      const up = diff >= 0;
                      const rankBadge = ([
                        'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-400',
                        'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
                        'bg-orange-100 text-orange-600 dark:bg-orange-400/20 dark:text-orange-400',
                      ] as const)[index];
                      return (
                        <div
                          key={agent.agentName}
                          className={`flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0 hover:bg-muted/40 ${index < 3 ? 'bg-muted/20' : ''}`}
                        >
                          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${rankBadge ?? 'text-[10px] font-semibold text-muted-foreground'}`}>
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-semibold text-foreground">{agent.agentName}</p>
                            <p className="tabular-nums text-[10px] text-muted-foreground">Inside: {fmtCell(agent.balanceInside)}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={`tabular-nums text-[11px] font-bold ${agent.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {fmtCell(agent.runningBalance, true)}
                            </p>
                            <p className={`tabular-nums text-[10px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {up ? '▲' : '▼'} {fmtCell(diff)}
                            </p>
                          </div>
                        </div>
                      );
                    }) : (
                      <EmptyState
                        title="No high-volume agents"
                        description="No agents currently meet the high-volume criteria."
                      />
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
