'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, RefreshCw, Search, Flag, Check, X, SquarePen, Loader2, Info, MessageSquare } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import DataTable from '@/app/components/DataTable';
import Toolbar from '@/app/components/Toolbar';
import ColumnsDropdown from '@/app/components/ColumnsDropdown';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '@/app/lib/csv';
import { getBusinessToday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';
import {
  computeCompanyBalance,
  resolveBrand,
  computeWalletStatus,
  computeBaseLimit,
  computeFrozenAmount,
  computeAvailableLimit,
} from '@/app/lib/balanceEngine';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';

// Mirrors app/lib/walletStatus.ts's own types — not imported directly since
// that file pulls in `googleapis` (Node-only, breaks the client bundle);
// every other page that reads a write-capable lib (e.g. Estimated Opening)
// follows this same "fetch via API route, define a matching local type"
// convention instead of importing the server-only module.
type DepositWithdrawal = 'Yes' | 'No';
type Priority = 'Low' | 'Normal' | 'High';
// Deposit/Withdrawal/Wallet Status are all derived from the wallet's actual
// operational status (same computeWalletStatus() used by Balance) — never
// manually set, so there's no "never set" blank state to account for here.
// Only Priority is a real staff-entered value read from the "Wallet Status"
// sheet tab.
type WalletStatusValue = 'Active' | 'Inactive' | 'Wallet With Issue';
// Remark fields ride along on the same per-shop API response — independent
// of Priority (a shop can have one without the other) but fetched together
// since both come from the same "Wallet Status" sheet tab / API route.
type PriorityEntry = { priority: Priority; remark: string; remarkUpdatedBy: string; remarkUpdatedAt: string };
const DEFAULT_PRIORITY_ENTRY: PriorityEntry = { priority: 'Normal', remark: '', remarkUpdatedBy: '', remarkUpdatedAt: '' };

const WALLET_STATUS_DOT: Record<WalletStatusValue, string> = {
  Active: 'bg-emerald-500',
  Inactive: 'bg-amber-400',
  'Wallet With Issue': 'bg-rose-500',
};

// Derives the 3 display fields from the wallet's real computeWalletStatus()
// result (same source Balance uses) per explicit instruction: Deposit/
// Withdrawal/Wallet Status must reflect what the wallet is actually open
// for, not an independently staff-set flag that can drift out of sync.
// - Open for DP+WD, DP Only, or WD Only -> "Active"; Deposit is "Yes" only
//   when DP capability is present, Withdrawal only when WD capability is.
// - Wallet With Issue -> passed through as its own status (not folded into
//   Active/Inactive).
// - Everything else (No Record, Disconnected, Top Up Acc., Account
//   Problem) -> "Inactive", with both Deposit and Withdrawal "No".
function deriveWalletFlags(computedStatus: string): { walletStatus: WalletStatusValue; deposit: DepositWithdrawal; withdrawal: DepositWithdrawal } {
  const hasDeposit = computedStatus === 'DP + WD' || computedStatus === 'DP Only';
  const hasWithdrawal = computedStatus === 'DP + WD' || computedStatus === 'WD Only';
  const walletStatus: WalletStatusValue = computedStatus === 'Wallet With Issue'
    ? 'Wallet With Issue'
    : hasDeposit || hasWithdrawal
      ? 'Active'
      : 'Inactive';
  return { walletStatus, deposit: hasDeposit ? 'Yes' : 'No', withdrawal: hasWithdrawal ? 'Yes' : 'No' };
}

// Format mimics Transfer Queue (app/sendmoney/transfer-queue/page.tsx) per
// explicit instruction — same GHOST_BUTTON toolbar, SettlementHeader,
// DataTable, native table, ColumnsDropdown, TableFooter, mobile card list.
// Column widths use Balance's own dynamic per-column measurement system
// (see computeColumnWidthsPx below) rather than colgroup/table-fixed — per
// explicit instruction to arrange sizing the same way as Balance. Cashout
// counterpart: app/wallet-status/page.tsx.
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-colors duration-150 ease-out hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

function displayNum(num: number): string {
  if (Math.abs(num) < 0.01) return '−';
  const formatted = Math.abs(num).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `-${formatted}` : formatted;
}

// Unlike displayNum, Available Limit always shows a real number — 0 is a
// meaningful, distinct state (limit fully used) from "no data", so it's
// never collapsed into the dash.
function displayAvailableLimit(num: number): string {
  const formatted = Math.abs(num).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `-${formatted}` : formatted;
}

// Exact hex values per spec — kept as literal Tailwind arbitrary-value
// classes (not the theme's semantic rose/emerald tokens) since these 4
// thresholds are a distinct, deliberately-specified palette.
function availableLimitColorClass(availableLimit: number, baseLimit: number): string {
  if (availableLimit <= 0 || baseLimit <= 0) return 'text-[#EF4444]';
  const pct = (availableLimit / baseLimit) * 100;
  if (pct < 30) return 'text-[#F97316]';
  if (pct < 70) return 'text-[#F59E0B]';
  return 'text-[#10B981]';
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseSheetDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

// Send Money's own agent keys aren't always cased/spaced the same between
// "Opening AG" and "PS BD STLM + TOPUP" — normalized before every map
// lookup, same fix as app/sendmoney/balances/page.tsx.
function normalizeAgentKey(name: string): string {
  return name.toUpperCase().replace(/\s+/g, '');
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
const BRAND_CODES = [...CASHOUT_BRAND_CODES, 'SH'];

const PRIORITY_OPTIONS: Priority[] = ['Low', 'Normal', 'High'];
const PRIORITY_RANK: Record<Priority, number> = { Low: 0, Normal: 1, High: 2 };

type WalletStatusRow = {
  key: string;
  shopName: string;
  brand: string;
  companyBalance: number;
  baseLimit: number;
  availableLimit: number;
  frozenAmount: number;
  sdpDisplay: string;
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  priority: Priority;
  walletStatus: WalletStatusValue;
  remark: string;
  remarkUpdatedBy: string;
  remarkUpdatedAt: string;
};

const COLUMN_IDS = {
  BRAND: 'brand',
  SHOP_NAME: 'shopName',
  COMPANY_BALANCE: 'companyBalance',
  AVAILABLE_LIMIT: 'availableLimit',
  FROZEN_AMOUNT: 'frozenAmount',
  SDP: 'sdp',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  PRIORITY: 'priority',
  WALLET_STATUS: 'walletStatus',
  REMARKS: 'remarks',
  WALLET_STATUS_ACTION: 'walletStatusAction',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];

type ColumnDef = {
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SHOP_NAME, label: 'Shop Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AVAILABLE_LIMIT, label: 'Available Limit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.FROZEN_AMOUNT, label: 'Frozen Amount', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SDP, label: 'SDP', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DEPOSIT, label: 'Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WITHDRAWAL, label: 'Withdrawal', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.PRIORITY, label: 'Priority', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: true, sortable: true, hideable: false, align: 'left' },
  // Independent of Wallet Status/Priority — its own click-to-edit popover,
  // not tied to the row-wide Edit/Save/Cancel below. Fixed width (see
  // computeColumnWidthsPx's own special-case), never measured from content.
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'left' },
  // Edit/Save/Cancel per ROW — Priority is the only field this saves;
  // Deposit/Withdrawal/Wallet Status are computed and read-only. Never
  // hideable — it's the only edit affordance for the row.
  { key: COLUMN_IDS.WALLET_STATUS_ACTION, label: '', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyWalletStatusColumnVisibility';

// Same dynamic per-column width system as Balance (app/sendmoney/balances/
// page.tsx): every column is sized to its own longest real value across
// the FULL dataset (not just the current page), so no column ever
// truncates its header or clips a value, and pagination/sorting never
// makes a column visibly jump. table-auto (no <colgroup>/table-fixed) +
// inline width/minWidth per cell, same as Balance.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidthPx(text: string, font: string): number {
  if (typeof document === 'undefined') return 0;
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Fonts/paddings mirror this page's own real classes exactly: header cell
// (text-[14px] font-semibold), body cell (text-[13px] font-normal), Brand
// badge (text-[12px] font-semibold), and the Deposit/Withdrawal/Priority/
// Wallet Status pill badges (text-[12px] font-medium).
const BODY_TEXT_FONT = '400 13px Inter, sans-serif';
const HEADER_TEXT_FONT = '600 14px Inter, sans-serif';
const BRAND_BADGE_FONT = '600 12px Inter, sans-serif';
const PILL_BADGE_FONT = '500 12px Inter, sans-serif';

// px-4 cell padding = 16px each side = 32px total, on every cell.
const CELL_PADDING_PX = 32;
// Sort icon + its gap reserve, for sortable headers only (see SortIcon).
const HEADER_SORT_ICON_RESERVE_PX = 20;
// Info icon + its gap reserve — Available Limit/Frozen Amount only.
const HEADER_INFO_ICON_RESERVE_PX = 18;
// Brand badge chrome beyond its text: px-[10px] (10px) each side + 1px
// border each side.
const BRAND_BADGE_CHROME_PX = 22;
// Deposit/Withdrawal/Priority pill chrome beyond its text: px-2 (8px)
// each side + 1px border each side.
const PILL_BADGE_CHROME_PX = 18;
// Wallet Status pill chrome beyond its text: px-2 (8px) each side + 1px
// border each side + the status dot (8px) + its gap-1.5 (6px).
const WALLET_STATUS_BADGE_CHROME_PX = 32;
// Extra breathing room so the longest value never sits flush against the
// next column's edge.
const EXTRA_BREATHING_ROOM_PX = 8;
// The Edit/Save/Cancel action column has no measurable text content (icon
// buttons only) — fixed wide enough for the Save+Cancel button pair.
const WALLET_STATUS_ACTION_WIDTH_PX = 96;
// Remarks is free text up to 500 chars — a fixed width (per spec), never
// grown to fit content; long remarks truncate with an ellipsis + tooltip.
// width===minWidth===maxWidth (same technique every other column here
// already uses) — this table is table-auto, not table-fixed, so a
// min-width smaller than width lets the browser shrink the column toward
// it when content is short (confirmed: a lone min:240/width:280 rendered
// at 240, not 280). Pinning all three equal is what actually guarantees a
// provably constant column, matching the spec's "must never change based
// on content" requirement literally.
const REMARKS_COLUMN_WIDTH_PX = 280;
// Hover delay before the full-remark tooltip appears — long enough that a
// quick pass-over the cell doesn't flash it, per spec.
const REMARKS_TOOLTIP_HOVER_DELAY_MS = 275;

const COLUMNS_WITH_INFO_ICON: ColumnKey[] = ['availableLimit', 'frozenAmount'];
const PILL_BADGE_COLUMNS: ColumnKey[] = ['deposit', 'withdrawal', 'priority'];

// Exact display string per column — mirrors renderCell's own per-column
// JSX content, kept as plain strings here purely for width measurement.
function getColumnDisplayText(row: WalletStatusRow, key: ColumnKey): string {
  switch (key) {
    case 'brand': return row.brand;
    case 'shopName': return row.shopName;
    case 'companyBalance': return displayNum(row.companyBalance);
    case 'availableLimit': return displayAvailableLimit(row.availableLimit);
    case 'frozenAmount': return displayNum(row.frozenAmount);
    case 'sdp': return row.sdpDisplay;
    case 'deposit': return row.deposit;
    case 'withdrawal': return row.withdrawal;
    case 'priority': return priorityDisplay(row);
    case 'walletStatus': return row.walletStatus;
    case 'remarks': return row.remark;
    default: return '';
  }
}

// For every visible column: measures the longest real value across the
// full dataset (plus each column's own badge chrome, where applicable),
// takes the max against the header label's own required width (so the
// label itself is never the thing that gets clipped), and returns a fixed
// px width to pin both the header and every body cell to.
function computeColumnWidthsPx(rows: WalletStatusRow[], columns: ColumnDef[]): Partial<Record<ColumnKey, number>> {
  const result: Partial<Record<ColumnKey, number>> = {};
  for (const col of columns) {
    if (col.key === 'walletStatusAction') {
      result[col.key] = WALLET_STATUS_ACTION_WIDTH_PX;
      continue;
    }
    if (col.key === 'remarks') {
      result[col.key] = REMARKS_COLUMN_WIDTH_PX;
      continue;
    }

    const font = col.key === 'brand' ? BRAND_BADGE_FONT
      : (PILL_BADGE_COLUMNS.includes(col.key) || col.key === 'walletStatus') ? PILL_BADGE_FONT
      : BODY_TEXT_FONT;
    const chrome = col.key === 'brand' ? BRAND_BADGE_CHROME_PX
      : col.key === 'walletStatus' ? WALLET_STATUS_BADGE_CHROME_PX
      : PILL_BADGE_COLUMNS.includes(col.key) ? PILL_BADGE_CHROME_PX
      : 0;

    let maxTextWidth = 0;
    for (const row of rows) {
      const w = measureTextWidthPx(getColumnDisplayText(row, col.key) ?? '', font);
      if (w > maxTextWidth) maxTextWidth = w;
    }
    const dataWidth = maxTextWidth > 0 ? Math.ceil(maxTextWidth) + chrome + CELL_PADDING_PX + EXTRA_BREATHING_ROOM_PX : 0;

    const headerWidth = Math.ceil(measureTextWidthPx(col.label, HEADER_TEXT_FONT))
      + CELL_PADDING_PX
      + (col.sortable ? HEADER_SORT_ICON_RESERVE_PX : 0)
      + (COLUMNS_WITH_INFO_ICON.includes(col.key) ? HEADER_INFO_ICON_RESERVE_PX : 0);

    const width = Math.max(dataWidth, headerWidth);
    if (width > 0) result[col.key] = width;
  }
  return result;
}

const rowSkeletonWidths: Record<ColumnKey, string[]> = {
  brand: ['w-8', 'w-10', 'w-9'],
  shopName: ['w-24', 'w-28', 'w-20'],
  companyBalance: ['w-16', 'w-20', 'w-14'],
  availableLimit: ['w-16', 'w-14', 'w-20'],
  frozenAmount: ['w-14', 'w-10', 'w-16'],
  sdp: ['w-14', 'w-16', 'w-12'],
  deposit: ['w-10', 'w-10', 'w-10'],
  withdrawal: ['w-10', 'w-10', 'w-10'],
  priority: ['w-14', 'w-14', 'w-14'],
  walletStatus: ['w-20', 'w-24', 'w-16'],
  remarks: ['w-32', 'w-24', 'w-36'],
  walletStatusAction: ['w-8', 'w-8', 'w-8'],
};

function headerCellClasses(align: 'left' | 'right' | 'center') {
  return `group overflow-hidden whitespace-nowrap px-4 text-${align} text-[14px] font-semibold text-[#475569] dark:text-[#9CA3AF]`;
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  return (
    <span className="flex w-3.5 shrink-0 items-center justify-center transition-colors duration-150 ease-out">
      {!active ? (
        <ChevronsUpDown size={14} className="text-[#94A3B8]" />
      ) : direction === 'asc' ? (
        <ChevronUp size={14} className="text-[#2563EB]" />
      ) : (
        <ChevronDown size={14} className="text-[#2563EB]" />
      )}
    </span>
  );
}

// Explains the Available Limit / Frozen Amount formulas on hover.
// Positioned BELOW its trigger (these triggers live in the sticky top
// header) — an above-anchored tooltip would run off-screen. Multi-line
// (whitespace-pre-line), unlike a single-line nowrap tooltip.
// Optional `delayMs` (default 0, unchanged for existing callers like
// HeaderInfoIcon) delays only the SHOW — hiding on mouse-leave is always
// instant, per spec ("close automatically when mouse leaves"). A pending
// show-timer is cancelled if the pointer leaves before it fires, so a
// quick pass-over never flashes the tooltip.
function useBelowTooltip(triggerRef: React.RefObject<HTMLElement | null>, options?: { delayMs?: number }) {
  const delayMs = options?.delayMs ?? 0;
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
      setRendered(true);
    } else {
      const timeout = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const scheduleOpen = useCallback(() => {
    if (delayMs > 0) {
      showTimerRef.current = setTimeout(() => setOpen(true), delayMs);
    } else {
      setOpen(true);
    }
  }, [delayMs]);

  const cancelOpen = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    setOpen(false);
  }, []);

  return {
    open,
    rendered,
    pos,
    handlers: {
      onMouseEnter: scheduleOpen,
      onMouseLeave: cancelOpen,
      onFocus: () => setOpen(true),
      onBlur: cancelOpen,
    },
  };
}

const COLUMN_INFO_TEXT: Partial<Record<ColumnKey, string>> = {
  availableLimit: "Remaining receiving capacity for today.\n\nFormula:\nBase Limit − Company Balance − Today's Total DP\n\nResets every day at 2:00 AM.",
  frozenAmount: 'Amount exceeding the allowed receiving limit.\n\nFormula:\nCompany Balance − Base Limit\n\nOnly shown when Company Balance exceeds the allowed limit.',
};

function HeaderInfoIcon({ text }: { text: string }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltip = useBelowTooltip(triggerRef);
  return (
    <span
      ref={triggerRef}
      role="img"
      aria-label="Info"
      {...tooltip.handlers}
      className="flex items-center text-[#94A3B8] transition-colors duration-150 hover:text-[#475569] dark:hover:text-[#CBD5E1]"
    >
      <Info size={11} />
      {tooltip.rendered && typeof document !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', top: tooltip.pos.top, left: tooltip.pos.left, transform: 'translate(-50%, 0)' }}
          className={`pointer-events-none z-[9999] w-[240px] whitespace-pre-line rounded-md bg-[#1F2937] px-3 py-2 text-left text-[11px] font-normal leading-relaxed text-white transition-opacity duration-150 ease-out ${tooltip.open ? 'opacity-100' : 'opacity-0'}`}
        >
          {text}
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#1F2937]" />
        </div>,
        document.body
      )}
    </span>
  );
}

const BRAND_BADGE_TINTS: Record<string, string> = {
  M1: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-900/50',
  M2: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border-cyan-900/50',
  B1: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  B2: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-900/50',
  B3: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/10 dark:text-fuchsia-400 dark:border-fuchsia-900/50',
  B4: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-900/50',
  B5: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-900/50',
  K1: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-900/50',
  J1: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/50',
  T1: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-400 dark:border-teal-900/50',
  SH: 'bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-500/10 dark:text-lime-400 dark:border-lime-900/50',
};

function brandBadgeClasses(brand: string): string {
  return BRAND_BADGE_TINTS[brand] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

function BrandBadge({ children }: { children: string }) {
  return (
    <span className={`inline-flex h-[28px] items-center rounded-[999px] border px-[10px] text-[12px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${brandBadgeClasses(children)}`}>
      {children}
    </span>
  );
}

// "July 22, 2026 10:42 AM" — Manila wall clock, matches the tooltip mockup's
// exact format (no comma between year and time, unlike Intl's own default).
function formatRemarkTimestamp(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

// The Remarks trigger — a single-line, ellipsis-truncated value (or an
// italic "Add Remark" placeholder when empty) that opens the shared,
// portal-rendered edit popover (see the page component's own
// `editingRemarkKey`/`RemarkEditorPopover`) on click, and shows the full
// remark + attribution on hover via the same useBelowTooltip pattern
// already used by HeaderInfoIcon. Independent of Priority/Wallet Status —
// no row-wide edit mode gates this.
function RemarksCell({
  remark,
  updatedBy,
  updatedAt,
  isEditing,
  onOpen,
}: {
  remark: string;
  updatedBy: string;
  updatedAt: string;
  isEditing: boolean;
  onOpen: (anchor: HTMLElement) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltip = useBelowTooltip(triggerRef, { delayMs: REMARKS_TOOLTIP_HOVER_DELAY_MS });
  const hasRemark = remark.trim() !== '';

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => triggerRef.current && onOpen(triggerRef.current)}
      {...(hasRemark ? tooltip.handlers : {})}
      className={`flex h-7 w-full max-w-full items-center gap-1 overflow-hidden rounded-md px-1.5 text-left transition-colors duration-150 ease-out hover:bg-muted/40 ${isEditing ? 'bg-muted/40' : ''}`}
    >
      {hasRemark && <MessageSquare size={12} className="shrink-0 text-muted-foreground" />}
      {hasRemark ? (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-normal text-slate-700 dark:text-slate-300">{remark}</span>
      ) : (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-normal italic text-slate-400 dark:text-slate-500">− Add Remark −</span>
      )}
      {hasRemark && tooltip.rendered && typeof document !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', top: tooltip.pos.top, left: tooltip.pos.left, transform: 'translate(-50%, 0)' }}
          className={`pointer-events-none z-[9999] max-w-[420px] whitespace-pre-line break-words rounded-md bg-[#1F2937] px-3 py-2 text-left text-[11px] font-normal leading-relaxed text-white transition-opacity duration-150 ease-out ${tooltip.open ? 'opacity-100' : 'opacity-0'}`}
        >
          {remark}
          {updatedBy && (
            <div className="mt-1.5 space-y-0.5 border-t border-white/15 pt-1.5 text-[10px] text-white/70">
              <div>Updated by: {updatedBy}</div>
              {updatedAt && <div>Updated at: {formatRemarkTimestamp(updatedAt)}</div>}
            </div>
          )}
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#1F2937]" />
        </div>,
        document.body
      )}
    </button>
  );
}

// "None" is a display-only state, never a selectable option or a stored
// value — the real Priority (Low/Normal/High) stays intact underneath so
// it reappears if the wallet becomes active again. Kept separate from
// `Priority` itself so PRIORITY_OPTIONS/the sheet's normalizePriority
// never have to account for a 4th value that was never actually settable.
type PriorityDisplay = Priority | 'None';

const PRIORITY_BADGE_TINTS: Record<PriorityDisplay, string> = {
  High: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-900/50',
  Normal: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700',
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/50',
  None: 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-500/5 dark:text-slate-500 dark:border-slate-800',
};

// An inactive wallet has no meaningful priority to work — read-only rest
// state shows "None" regardless of whatever Priority was last saved for
// it. Editing (StatusSelect in edit mode) still operates on the real
// saved value, so staff can pre-set a priority ahead of it going active
// again without that edit being visible while it's inactive.
function priorityDisplay(row: WalletStatusRow): PriorityDisplay {
  return row.walletStatus === 'Inactive' ? 'None' : row.priority;
}

// Native <select> kept intentionally plain (no custom dropdown/portal) —
// this is a live, persisted edit per cell, not a filter; a plain select is
// the simplest control that can't be mistaken for a filter trigger. Only
// used for Priority now — Deposit/Withdrawal/Wallet Status are computed and
// render as plain badges directly in renderCell, never through this
// component.
//
// Read-only (disabled) until the row's own Edit icon is clicked — changing
// it only stages a draft, never saves directly; the row's Action column
// Save/Cancel commits or discards it.
// Read-only rest state renders a plain, fully-opaque badge — no <select>,
// no chevron, no dimmed "disabled" look. Per explicit instruction: a
// dropdown chevron before Edit is clicked reads as "this is clickable"
// when it isn't yet, and a faded/opacity-reduced look reads as broken —
// the value at rest should just be clearly legible text. Only once
// `editing` is true (this row's Edit icon was clicked) does it become a
// real interactive <select>.
function StatusSelect<T extends string>({
  value,
  options,
  onChange,
  editing,
  saving,
  className,
}: {
  value: T;
  options: T[];
  onChange: (next: T) => void;
  editing: boolean;
  saving: boolean;
  className: string;
}) {
  if (!editing) {
    return (
      <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${className}`}>
        {value}
      </span>
    );
  }
  return (
    <select
      value={value}
      disabled={saving}
      onChange={(event) => onChange(event.target.value as T)}
      className={`h-7 rounded-md border px-1.5 text-[12px] font-medium outline-none transition-opacity disabled:opacity-60 ${className}`}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

// Deposit/Withdrawal/Wallet Status are computed (see deriveWalletFlags) —
// Priority is the only field a staff member can actually edit and persist.
type RowDraft = { priority: Priority };

function rowHasChanges(row: WalletStatusRow, draft: RowDraft | null): boolean {
  if (!draft) return false;
  return draft.priority !== row.priority;
}

export default function SendMoneyWalletStatus() {
  const [rows, setRows] = useState<WalletStatusRow[]>([]);

  // Fixed width per column — sized to each column's own longest real value
  // across the FULL dataset (not the current page/search/sort slice), so
  // every column stays constant no matter which rows are on screen.
  // Computed over DEFAULT_COLUMNS (not visibleColumns) so it never depends
  // on columnDefs' own declaration order below.
  const colWidthsPx = useMemo(() => computeColumnWidthsPx(rows, DEFAULT_COLUMNS), [rows]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // One row editable at a time — Priority is the only field this stages.
  // editingRowKey being a single value (not a Set/per-field map) is what
  // makes "starting to edit another row auto-cancels the previous one"
  // free — the old row's cell just stops matching and reverts to showing
  // its saved value with no extra cleanup needed.
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<RowDraft | null>(null);
  const [rowSaving, setRowSaving] = useState(false);

  // Remarks' own independent edit state — deliberately separate from
  // editingRowKey/editDraft above (Priority's row-wide edit mode). A remark
  // popover and a Priority edit can be open at the same time; they don't
  // gate each other.
  const [editingRemarkKey, setEditingRemarkKey] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState('');
  const [remarkSaving, setRemarkSaving] = useState(false);
  const [remarkAnchor, setRemarkAnchor] = useState<HTMLElement | null>(null);
  const [remarkPopoverPos, setRemarkPopoverPos] = useState({ top: 0, left: 0 });
  const remarkPopoverRef = useRef<HTMLDivElement>(null);

  const [isScrolled, setIsScrolled] = useState(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [atScrollStart, setAtScrollStart] = useState(true);
  const [atScrollEnd, setAtScrollEnd] = useState(true);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      setIsScrolled(el.scrollTop > 0);
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
  }, []);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [openingRes, balRes, stlmRes, statusRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/sendmoney/wallet-status?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, statusRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();
      const statusData: Record<string, PriorityEntry> = await statusRes.json();

      const reportCutoffDate = getBusinessToday();

      // Send Money's own roster lives in cols L-O (indices 11-14) of the
      // same "Opening AG" sheet Cashout uses for cols A-D.
      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[11]),
          openingBal: rawVal(row[12]),
          sdp: rawVal(row[13]),
          leader: rawVal(row[14]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      // "SSP PS BalanceLimit" lines up column-for-column with Cashout's own
      // sheet from index 4 onward — no leading "Reference" column, so
      // Wallet Name/Account Status shift down by 1 (same as
      // app/sendmoney/balances/page.tsx).
      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[0]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          group: rawVal(row[6]),
          accountStatus: rawVal(row[1]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const brandGroups = new Map<string, string[]>();
      const walletStatusValues = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(bal.walletName) ?? { dp: 0, wd: 0 };
        balanceTotals.set(bal.walletName, { dp: existing.dp + dp, wd: existing.wd + wd });

        if (bal.group && bal.group !== '-') {
          const groups = brandGroups.get(bal.walletName) ?? [];
          groups.push(bal.group);
          brandGroups.set(bal.walletName, groups);
        }

        if (bal.accountStatus && bal.accountStatus !== '-') {
          const statuses = walletStatusValues.get(bal.walletName) ?? [];
          statuses.push(bal.accountStatus);
          walletStatusValues.set(bal.walletName, statuses);
        }
      });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = normalizeAgentKey(rawVal(row[1]));
          const topUpAmount = rawVal(row[2]);
          const topUpDate = parseSheetDate(rawVal(row[3]));
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' && topUpDate && topUpDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }
          const stlmAgent = normalizeAgentKey(rawVal(row[7]));
          const stlmAmount = rawVal(row[8]);
          const stlmDate = parseSheetDate(rawVal(row[9]));
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' && stlmDate && stlmDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: WalletStatusRow[] = openingRows.map((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(normalizeAgentKey(opening.agentName)) ?? 0;
        const totalStlm = stlmTotals.get(normalizeAgentKey(opening.agentName)) ?? 0;
        const companyBalance = computeCompanyBalance(parseNumber(opening.openingBal), totals.dp, totalTopUp, totals.wd, totalStlm);
        const sdpNum = parseNumber(opening.sdp);
        const baseLimit = computeBaseLimit(sdpNum);
        const sdpTrimmed = opening.sdp.trim().toUpperCase();
        const sdpDisplay = sdpTrimmed === 'NO SDP' || !opening.sdp || opening.sdp === '-' ? '−' : displayNum(sdpNum);
        const computedStatus = balWalletNames.has(opening.agentName)
          ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
          : 'No Record';
        const flags = deriveWalletFlags(computedStatus);
        const priorityEntry = statusData[opening.agentName.toUpperCase()] ?? DEFAULT_PRIORITY_ENTRY;
        // An inactive wallet can't receive DP at all, so its receiving
        // capacity is definitionally 0 — overridden here (not just at
        // display time) so sorting/export/color all agree with what's
        // shown, per explicit instruction.
        const availableLimit = flags.walletStatus === 'Inactive' ? 0 : computeAvailableLimit(baseLimit, companyBalance, totals.dp);
        return {
          key: opening.agentName,
          shopName: opening.agentName,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES, validateComputedBrand: true }),
          companyBalance,
          baseLimit,
          availableLimit,
          frozenAmount: computeFrozenAmount(companyBalance, baseLimit),
          sdpDisplay,
          deposit: flags.deposit,
          withdrawal: flags.withdrawal,
          priority: priorityEntry.priority,
          walletStatus: flags.walletStatus,
          remark: priorityEntry.remark,
          remarkUpdatedBy: priorityEntry.remarkUpdatedBy,
          remarkUpdatedAt: priorityEntry.remarkUpdatedAt,
        };
      });

      setRows(merged);
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

  useEffect(() => {
    setPage(1);
  }, [searchTerm, sortColumn, sortDirection, rowsPerPage]);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  useEffect(() => {
    setMounted(true);
    const saved = getPreference<Record<string, boolean> | null>(COLUMN_VISIBILITY_STORAGE_KEY, null);
    if (!saved) return;
    setColumnDefs((current) => current.map((col) => (col.key in saved ? { ...col, visible: saved[col.key] } : col)));
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const visibility = Object.fromEntries(columnDefs.map((col) => [col.key, col.visible])) as Record<ColumnKey, boolean>;
    setPreference(COLUMN_VISIBILITY_STORAGE_KEY, visibility);
  }, [columnDefs, mounted]);

  // Click Edit -> stage a draft (seeded from the row's current saved
  // Priority) and enter edit mode. Nothing saves until Save is clicked;
  // Cancel just discards the draft. editingRowKey being a single value
  // means starting to edit a different row automatically ends the previous
  // edit — its cells just stop matching and fall back to showing their
  // saved value.
  const startEdit = useCallback((row: WalletStatusRow) => {
    setEditingRowKey(row.key);
    setEditDraft({ priority: row.priority });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingRowKey(null);
    setEditDraft(null);
  }, []);

  const updateDraftField = useCallback((value: Priority) => {
    setEditDraft((current) => (current ? { ...current, priority: value } : current));
  }, []);

  // The single point where a row's staged Priority edit actually persists,
  // to the "Wallet Status" sheet tab (see app/lib/walletStatus.ts). On
  // failure, refetches from the server instead of assuming the write
  // didn't land.
  const saveRow = useCallback((row: WalletStatusRow) => {
    if (!editDraft || !rowHasChanges(row, editDraft)) return;
    const value = editDraft.priority;

    setRowSaving(true);
    setSaveError(null);

    fetch('/api/sendmoney/wallet-status/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: row.shopName, field: 'priority', value }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Save failed for priority');
        setRows((current) => current.map((r) => (r.key === row.key ? { ...r, priority: value } : r)));
        cancelEdit();
        setToast('Changes Saved');
      })
      .catch(() => {
        setSaveError(`Failed to save ${row.shopName} — reloading to confirm what actually saved.`);
        setTimeout(() => setSaveError(null), 5000);
        cancelEdit();
        fetchData();
      })
      .finally(() => {
        setRowSaving(false);
      });
  }, [editDraft, cancelEdit, fetchData]);

  // Opens the shared Remarks popover, anchored to whichever cell/mobile
  // trigger was clicked. A single editingRemarkKey means starting to edit a
  // different shop's remark auto-closes the previous popover, same
  // "one at a time" convention as Priority's editingRowKey — but this state
  // is entirely separate from it, so a Priority edit and a Remarks edit can
  // be open simultaneously without conflict.
  const openRemarkEditor = useCallback((row: WalletStatusRow, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setRemarkPopoverPos({ top: rect.bottom + 6, left: rect.left });
    setRemarkAnchor(anchor);
    setEditingRemarkKey(row.key);
    setRemarkDraft(row.remark);
  }, []);

  const cancelRemarkEdit = useCallback(() => {
    setEditingRemarkKey(null);
    setRemarkDraft('');
    setRemarkAnchor(null);
  }, []);

  const saveRemark = useCallback((row: WalletStatusRow) => {
    setRemarkSaving(true);
    setSaveError(null);

    fetch('/api/sendmoney/wallet-status/update-remark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: row.shopName, remark: remarkDraft }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Save failed for remark');
        const data: { updatedBy: string; updatedAt: string } = await res.json();
        setRows((current) => current.map((r) => (r.key === row.key
          ? { ...r, remark: remarkDraft, remarkUpdatedBy: data.updatedBy, remarkUpdatedAt: data.updatedAt }
          : r)));
        cancelRemarkEdit();
        setToast('Changes Saved');
      })
      .catch(() => {
        setSaveError(`Failed to save remark for ${row.shopName} — reloading to confirm what actually saved.`);
        setTimeout(() => setSaveError(null), 5000);
        cancelRemarkEdit();
        fetchData();
      })
      .finally(() => {
        setRemarkSaving(false);
      });
  }, [remarkDraft, cancelRemarkEdit, fetchData]);

  // Click-outside-to-cancel — same convention as this page's other
  // dropdowns/menus. Ignores clicks on the popover itself or its anchor
  // trigger (the anchor's own onClick already handles re-opening/toggling).
  useEffect(() => {
    if (!editingRemarkKey) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (remarkPopoverRef.current?.contains(target)) return;
      if (remarkAnchor?.contains(target)) return;
      cancelRemarkEdit();
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [editingRemarkKey, remarkAnchor, cancelRemarkEdit]);

  // Keeps the popover pinned to its anchor cell if the table scrolls or the
  // window resizes while it's open (it's a fixed-position portal, so it
  // wouldn't otherwise move with the row it belongs to).
  useEffect(() => {
    if (!editingRemarkKey || !remarkAnchor) return;
    function reposition() {
      const rect = remarkAnchor!.getBoundingClientRect();
      setRemarkPopoverPos({ top: rect.bottom + 6, left: rect.left });
    }
    const scrollEl = tableScrollRef.current;
    scrollEl?.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition);
    return () => {
      scrollEl?.removeEventListener('scroll', reposition);
      window.removeEventListener('resize', reposition);
    };
  }, [editingRemarkKey, remarkAnchor]);

  const editingRemarkRow = useMemo(() => rows.find((r) => r.key === editingRemarkKey) ?? null, [rows, editingRemarkKey]);

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => `${row.shopName} ${row.brand} ${row.remark}`.toLowerCase().includes(query));
  }, [rows, searchTerm]);

  const sortedRows = useMemo(() => {
    const list = [...searchedRows];
    list.sort((a, b) => {
      // Remarks sorts by string, but per spec, rows with no remark always
      // sort to the end regardless of asc/desc direction — handled as its
      // own branch since it doesn't fit the generic reverse-on-desc rule
      // every other column below follows.
      if (sortColumn === 'remarks') {
        const aEmpty = a.remark.trim() === '';
        const bEmpty = b.remark.trim() === '';
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        const comparison = a.remark.toLowerCase().localeCompare(b.remark.toLowerCase());
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const getValue = (row: WalletStatusRow, column: ColumnKey) => {
        switch (column) {
          case 'brand': return row.brand.toLowerCase();
          case 'shopName': return row.shopName.toLowerCase();
          case 'companyBalance': return row.companyBalance;
          case 'availableLimit': return row.availableLimit;
          case 'frozenAmount': return row.frozenAmount;
          case 'sdp': return row.sdpDisplay === '−' ? -Infinity : parseNumber(row.sdpDisplay);
          case 'deposit': return row.deposit;
          case 'withdrawal': return row.withdrawal;
          case 'priority': return PRIORITY_RANK[row.priority];
          case 'walletStatus': return row.walletStatus;
          default: return row.companyBalance;
        }
      };
      const valueA = getValue(a, sortColumn);
      const valueB = getValue(b, sortColumn);
      if (typeof valueA === 'string' || typeof valueB === 'string') {
        const comparison = String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const comparison = Number(valueA) - Number(valueB);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [searchedRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, startIndex + rowsPerPage);

  const visibleColumns = useMemo(() => (mounted ? columnDefs : []).filter((col) => col.visible), [columnDefs, mounted]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: WalletStatusRow, key: ColumnKey) => {
      switch (key) {
        case 'brand': return row.brand;
        case 'shopName': return row.shopName;
        case 'companyBalance': return row.companyBalance;
        case 'availableLimit': return row.availableLimit;
        case 'frozenAmount': return row.frozenAmount > 0 ? row.frozenAmount : undefined;
        case 'sdp': return row.sdpDisplay;
        case 'deposit': return row.deposit;
        case 'withdrawal': return row.withdrawal;
        case 'priority': return priorityDisplay(row);
        case 'walletStatus': return row.walletStatus;
        case 'remarks': return row.remark || '—';
      }
    };
    // The Edit/Save/Cancel action column has no exportable value — excluded
    // from the sheet rather than producing an empty, unlabeled column.
    const exportColumns = visibleColumns.filter((col) => col.key !== 'walletStatusAction');
    const headers = exportColumns.map((col) => col.label);
    const data = sortedRows.map((row) => exportColumns.map((col) => getExportValue(row, col.key)));
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Wallet Status');
    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_WALLET_STATUS_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  // Success toast — top right, 2s, per spec.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  function renderCell(row: WalletStatusRow, key: ColumnKey, colWidthsPx?: Partial<Record<ColumnKey, number>>) {
    const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-center px-4 py-[14px] align-top';
    const shopBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-left px-4 py-[14px] align-top';
    const isEditingThisRow = editingRowKey === row.key;
    const width = colWidthsPx?.[key];
    const cellStyle = width ? { width, minWidth: width } : undefined;
    switch (key) {
      case 'brand':
        return <td key={key} style={cellStyle} className={base}><BrandBadge>{row.brand}</BrandBadge></td>;
      case 'shopName':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{row.shopName}</td>;
      case 'companyBalance':
        return (
          <td key={key} style={cellStyle} className={`${base} tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
            {displayNum(row.companyBalance)}
          </td>
        );
      case 'availableLimit':
        return (
          <td key={key} style={cellStyle} className={`${base} tabular-nums ${availableLimitColorClass(row.availableLimit, row.baseLimit)}`}>
            {displayAvailableLimit(row.availableLimit)}
          </td>
        );
      case 'frozenAmount': {
        const formatted = displayNum(row.frozenAmount);
        return (
          <td key={key} style={cellStyle} className={`${base} tabular-nums ${formatted === '−' ? 'text-muted-foreground' : 'text-[#EF4444]'}`}>
            {formatted}
          </td>
        );
      }
      case 'sdp':
        return <td key={key} style={cellStyle} className={`${base} tabular-nums text-foreground`}>{row.sdpDisplay}</td>;
      case 'deposit':
        return (
          <td key={key} style={cellStyle} className={base}>
            <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${row.deposit === 'Yes'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
              {row.deposit}
            </span>
          </td>
        );
      case 'withdrawal':
        return (
          <td key={key} style={cellStyle} className={base}>
            <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${row.withdrawal === 'Yes'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
              {row.withdrawal}
            </span>
          </td>
        );
      case 'priority': {
        if (!isEditingThisRow) {
          const displayValue = priorityDisplay(row);
          return (
            <td key={key} style={cellStyle} className={base}>
              <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${PRIORITY_BADGE_TINTS[displayValue]}`}>
                {displayValue}
              </span>
            </td>
          );
        }
        const value = editDraft ? editDraft.priority : row.priority;
        return (
          <td key={key} style={cellStyle} className={base}>
            <StatusSelect
              value={value}
              options={PRIORITY_OPTIONS}
              editing
              saving={rowSaving}
              onChange={(next) => updateDraftField(next)}
              className={PRIORITY_BADGE_TINTS[value]}
            />
          </td>
        );
      }
      case 'walletStatus':
        return (
          <td key={key} style={cellStyle} className={shopBase}>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 text-[12px] font-medium text-foreground">
              <span className={`h-2 w-2 shrink-0 rounded-full ${WALLET_STATUS_DOT[row.walletStatus]}`} />
              {row.walletStatus}
            </span>
          </td>
        );
      case 'remarks':
        // Own style object (not the shared `cellStyle`) — width/minWidth/
        // maxWidth per spec, rather than the generic width===minWidth every
        // other column uses. Never grows with content either way.
        return (
          <td
            key={key}
            style={{ width: REMARKS_COLUMN_WIDTH_PX, minWidth: REMARKS_COLUMN_WIDTH_PX, maxWidth: REMARKS_COLUMN_WIDTH_PX }}
            className={`${shopBase} !overflow-visible`}
          >
            <RemarksCell
              remark={row.remark}
              updatedBy={row.remarkUpdatedBy}
              updatedAt={row.remarkUpdatedAt}
              isEditing={editingRemarkKey === row.key}
              onOpen={(anchor) => openRemarkEditor(row, anchor)}
            />
          </td>
        );
      case 'walletStatusAction': {
        if (!isEditingThisRow) {
          return (
            <td key={key} style={cellStyle} className={base}>
              <button
                type="button"
                onClick={() => startEdit(row)}
                aria-label="Edit"
                title="Edit"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
              >
                <SquarePen size={15} />
              </button>
            </td>
          );
        }
        const canSave = rowHasChanges(row, editDraft);
        return (
          <td key={key} style={cellStyle} className={base}>
            <span className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => saveRow(row)}
                disabled={!canSave || rowSaving}
                aria-label="Save Changes"
                title="Save Changes"
                className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#5B5CEB] text-white transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
              >
                {rowSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={rowSaving}
                aria-label="Cancel"
                title="Cancel"
                className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#E5E7EB] bg-white text-slate-500 transition-colors duration-150 ease-out hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:border-rose-900/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
              >
                <X size={16} />
              </button>
            </span>
          </td>
        );
      }
    }
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      {toast && (
        <div className="fixed right-5 top-5 z-[100] flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3.5 py-2.5 text-[12px] font-medium text-foreground shadow-lg dark:border-emerald-900/50 dark:bg-[#2a2a2d]">
          <Check size={15} className="shrink-0 text-emerald-500" />
          {toast}
        </div>
      )}
      {editingRemarkRow && typeof document !== 'undefined' && createPortal(
        <div
          ref={remarkPopoverRef}
          style={{ position: 'fixed', top: remarkPopoverPos.top, left: remarkPopoverPos.left }}
          className="z-[200] w-[280px] rounded-[10px] border border-border bg-white p-2.5 shadow-lg dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
        >
          <textarea
            autoFocus
            maxLength={500}
            rows={4}
            value={remarkDraft}
            onChange={(e) => setRemarkDraft(e.target.value)}
            placeholder="Add a remark…"
            className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[#2563EB] dark:border-[#3a3a3d]"
          />
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelRemarkEdit}
              disabled={remarkSaving}
              className="flex h-8 items-center gap-1 rounded-[8px] border border-[#E5E7EB] bg-white px-2.5 text-[12px] font-medium text-slate-500 transition-colors duration-150 ease-out hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:border-rose-900/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
            >
              <X size={13} /> Cancel
            </button>
            <button
              type="button"
              onClick={() => saveRemark(editingRemarkRow)}
              disabled={remarkSaving}
              className="flex h-8 items-center gap-1 rounded-[8px] bg-[#5B5CEB] px-2.5 text-[12px] font-semibold text-white transition-opacity duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40"
            >
              {remarkSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
          </div>
        </div>,
        document.body
      )}
      <SettlementHeader icon={Flag} title="Wallet Status" isRefreshing={spinning} onRefresh={fetchData} />

      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-4">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            {saveError && (
              <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-400">
                {saveError}
              </div>
            )}
            <Toolbar>
              <Toolbar.Left>
                <div className="flex h-10 w-full min-w-[200px] items-center gap-2 rounded-[10px] border border-border bg-white px-[14px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:bg-[#2a2a2d] sm:w-[380px]">
                  {loading ? (
                    <div className="dt-skeleton h-3 w-32 rounded-md" />
                  ) : (
                    <>
                      <Search size={16} className="shrink-0 text-muted-foreground" />
                      <input
                        aria-label="Search shops or brands"
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[13px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                        placeholder="Search shops or brands..."
                      />
                    </>
                  )}
                </div>
              </Toolbar.Left>
              <Toolbar.Right>
                {loading && <div className="dt-skeleton h-8 w-8 rounded-[8px]" />}
                {!loading && (
                  <button type="button" onClick={fetchData} aria-label="Refresh" title="Refresh" className={GHOST_BUTTON}>
                    <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
                  </button>
                )}
                {loading && <div className="dt-skeleton h-9 w-[88px] rounded-[8px]" />}
                {!loading && (
                  <button type="button" onClick={handleExport} aria-label="Export to Excel" title="Export to Excel" className={GHOST_BUTTON}>
                    <Download size={15} />
                    Export
                  </button>
                )}
                {loading && <div className="dt-skeleton h-9 w-[104px] rounded-[8px]" />}
                {!loading && (
                  <div className="relative">
                    <button
                      type="button"
                      ref={columnsButtonRef}
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="sendmoney-wallet-status-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className={GHOST_BUTTON}
                    >
                      <Columns3 size={15} />
                      Columns
                    </button>
                    <ColumnsDropdown
                      id="sendmoney-wallet-status-columns-popover"
                      open={columnsMenuOpen}
                      onOpenChange={setColumnsMenuOpen}
                      anchorRef={columnsButtonRef}
                      columns={columnDefs}
                      onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))}
                      onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                    />
                  </div>
                )}
              </Toolbar.Right>
            </Toolbar>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''}`}>
                    <tr className="h-[48px]">
                      {visibleColumns.map((col) => (
                        <th
                          key={col.key}
                          style={col.key === 'remarks'
                            ? { width: REMARKS_COLUMN_WIDTH_PX, minWidth: REMARKS_COLUMN_WIDTH_PX, maxWidth: REMARKS_COLUMN_WIDTH_PX }
                            : colWidthsPx[col.key] ? { width: colWidthsPx[col.key], minWidth: colWidthsPx[col.key] } : undefined}
                          className={headerCellClasses(col.align)}
                        >
                          {loading ? (
                            <div className={`h-3 w-3/5 max-w-[72px] dt-skeleton rounded-md ${col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''}`} />
                          ) : col.sortable ? (
                            <button
                              type="button"
                              onClick={() => {
                                if (sortColumn === col.key) {
                                  setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setSortColumn(col.key);
                                  setSortDirection('asc');
                                }
                              }}
                              className={`flex w-full items-center gap-1.5 transition hover:opacity-80 ${col.align === 'center' ? 'justify-center' : 'justify-start'}`}
                            >
                              {col.align === 'center' && (
                                <span aria-hidden="true" className="invisible flex items-center gap-1.5">
                                  {COLUMN_INFO_TEXT[col.key] && <Info size={11} />}
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              )}
                              <span className={`min-w-0 truncate ${col.align === 'center' ? 'flex-1' : ''}`}>{col.label}</span>
                              <span className="flex items-center gap-1.5">
                                {COLUMN_INFO_TEXT[col.key] && (
                                  <span onClick={(e) => e.stopPropagation()}>
                                    <HeaderInfoIcon text={COLUMN_INFO_TEXT[col.key]!} />
                                  </span>
                                )}
                                <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                              </span>
                            </button>
                          ) : (
                            col.label
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      Array.from({ length: 18 }).map((_, rowIndex) => (
                        <tr key={rowIndex}>
                          {visibleColumns.map((col) => {
                            const widths = rowSkeletonWidths[col.key];
                            const width = widths[rowIndex % widths.length];
                            const colWidth = colWidthsPx[col.key];
                            return (
                              <td
                                key={col.key}
                                style={colWidth ? { width: colWidth, minWidth: colWidth } : undefined}
                                className="px-4 py-[14px]"
                              >
                                <div className={`dt-skeleton h-2.5 rounded-md ${width}`} />
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    ) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                      <tr
                        key={row.key}
                        className={`border-b last:border-0 transition-[background-color,border-color] duration-150 ease-out hover:bg-muted/10 ${
                          editingRowKey === row.key
                            ? 'border-b-border border-l-[3px] border-l-[#5B5CEB] bg-[#F8F9FF] dark:bg-[#5B5CEB]/[0.08]'
                            : `border-border ${i % 2 === 1 ? 'bg-muted/5' : ''}`
                        }`}
                      >
                        {visibleColumns.map((col) => renderCell(row, col.key, colWidthsPx))}
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={Math.max(visibleColumns.length, 1)}>
                          <EmptyState title="No shops found" description="No shops match the current search." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {!atScrollStart && (
                <div className="pointer-events-none absolute inset-y-0 left-0 z-[55] w-6 bg-gradient-to-r from-white to-transparent dark:from-[#2a2a2d]" />
              )}
              {!atScrollEnd && (
                <div className="pointer-events-none absolute inset-y-0 right-0 z-[55] w-6 bg-gradient-to-l from-white to-transparent dark:from-[#2a2a2d]" />
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto sm:hidden">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="h-4 w-2/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-3 w-1/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-3 h-6 w-1/2 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row) => {
                    const showShop = visibleColumns.some((c) => c.key === 'shopName');
                    const showBrand = visibleColumns.some((c) => c.key === 'brand');
                    const showBalance = visibleColumns.some((c) => c.key === 'companyBalance');
                    const showAvailableLimit = visibleColumns.some((c) => c.key === 'availableLimit');
                    const showFrozenAmount = visibleColumns.some((c) => c.key === 'frozenAmount');
                    const showSdp = visibleColumns.some((c) => c.key === 'sdp');
                    const showDeposit = visibleColumns.some((c) => c.key === 'deposit');
                    const showWithdrawal = visibleColumns.some((c) => c.key === 'withdrawal');
                    const showPriority = visibleColumns.some((c) => c.key === 'priority');
                    const showWalletStatus = visibleColumns.some((c) => c.key === 'walletStatus');
                    const showRemarks = visibleColumns.some((c) => c.key === 'remarks');
                    const isEditingThisRow = editingRowKey === row.key;
                    const priorityValue = isEditingThisRow && editDraft ? editDraft.priority : row.priority;
                    const canSave = rowHasChanges(row, editDraft);
                    return (
                      <div
                        key={row.key}
                        className={`rounded-xl border p-3.5 transition-[background-color,border-color] duration-150 ease-out dark:bg-[#2a2a2d] ${
                          isEditingThisRow ? 'border-[#5B5CEB] bg-[#F8F9FF] dark:bg-[#5B5CEB]/[0.08]' : 'border-border bg-white'
                        }`}
                      >
                        {(showShop || showBrand) && (
                          <div className="flex items-start justify-between gap-2">
                            {showShop && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.shopName}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{row.brand}</span>}
                          </div>
                        )}
                        {(showBalance || showAvailableLimit || showFrozenAmount || showSdp) && (
                          <div className={`grid grid-cols-2 gap-2 ${(showShop || showBrand) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showBalance && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Company Balance</p>
                                <p className={`text-[13px] font-bold tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{displayNum(row.companyBalance)}</p>
                              </div>
                            )}
                            {showAvailableLimit && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Available Limit</p>
                                <p className={`text-[13px] font-semibold tabular-nums ${availableLimitColorClass(row.availableLimit, row.baseLimit)}`}>{displayAvailableLimit(row.availableLimit)}</p>
                              </div>
                            )}
                            {showFrozenAmount && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Frozen Amount</p>
                                <p className={`text-[13px] font-semibold tabular-nums ${displayNum(row.frozenAmount) === '−' ? 'text-muted-foreground' : 'text-[#EF4444]'}`}>{displayNum(row.frozenAmount)}</p>
                              </div>
                            )}
                            {showSdp && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">SDP</p>
                                <p className="text-[13px] font-semibold tabular-nums text-foreground">{row.sdpDisplay}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {(showDeposit || showWithdrawal || showPriority) && (
                          <div className={`flex flex-wrap items-center gap-2 ${(showShop || showBrand || showBalance || showAvailableLimit || showFrozenAmount || showSdp) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showDeposit && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Deposit</p>
                                <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${row.deposit === 'Yes'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                                  : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
                                  {row.deposit}
                                </span>
                              </div>
                            )}
                            {showWithdrawal && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Withdrawal</p>
                                <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${row.withdrawal === 'Yes'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                                  : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
                                  {row.withdrawal}
                                </span>
                              </div>
                            )}
                            {showPriority && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Priority</p>
                                {isEditingThisRow ? (
                                  <StatusSelect
                                    value={priorityValue}
                                    options={PRIORITY_OPTIONS}
                                    editing
                                    saving={rowSaving}
                                    onChange={(next) => updateDraftField(next)}
                                    className={PRIORITY_BADGE_TINTS[priorityValue]}
                                  />
                                ) : (
                                  <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${PRIORITY_BADGE_TINTS[priorityDisplay(row)]}`}>
                                    {priorityDisplay(row)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {showWalletStatus && (
                          <div className={`flex items-center gap-1.5 ${(showShop || showBrand || showBalance || showAvailableLimit || showFrozenAmount || showSdp || showDeposit || showWithdrawal || showPriority) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            <p className="text-[9px] font-medium text-muted-foreground">Wallet Status</p>
                            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${WALLET_STATUS_DOT[row.walletStatus]}`} />
                              {row.walletStatus}
                            </span>
                          </div>
                        )}
                        {showRemarks && (
                          <div className="mt-2.5 border-t border-border pt-2.5">
                            <p className="mb-1 text-[9px] font-medium text-muted-foreground">Remarks</p>
                            <RemarksCell
                              remark={row.remark}
                              updatedBy={row.remarkUpdatedBy}
                              updatedAt={row.remarkUpdatedAt}
                              isEditing={editingRemarkKey === row.key}
                              onOpen={(anchor) => openRemarkEditor(row, anchor)}
                            />
                          </div>
                        )}
                        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
                          {isEditingThisRow ? (
                            <>
                              <button
                                type="button"
                                onClick={() => saveRow(row)}
                                disabled={!canSave || rowSaving}
                                className="flex h-8 flex-1 items-center justify-center gap-1 rounded-[10px] bg-[#5B5CEB] text-[12px] font-semibold text-white transition-opacity duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {rowSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={rowSaving}
                                className="flex h-8 flex-1 items-center justify-center gap-1 rounded-[10px] border border-[#E5E7EB] bg-white text-[12px] font-semibold text-slate-500 transition-colors duration-150 ease-out hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:border-rose-900/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                              >
                                <X size={14} /> Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEdit(row)}
                              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md text-[12px] font-semibold text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
                            >
                              <SquarePen size={14} /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState title="No shops found" description="No shops match the current search." />
                )}
              </div>
            </div>

            {!loading && (
              <TableFooter
                recordCountText={
                  sortedRows.length === 0
                    ? 'Showing 0 of 0 Shops'
                    : `Showing ${startIndex + 1}–${Math.min(startIndex + rowsPerPage, sortedRows.length)} of ${sortedRows.length} Shops`
                }
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
                pageSize={rowsPerPage}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={handlePageSizeChange}
                totalRecords={sortedRows.length}
                variant="premium"
              />
            )}
          </DataTable>
        )}
      </main>
    </div>
  );
}
