'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, Columns3, Download, RefreshCw, Search, Wallet,
  TrendingUp, ArrowDownToLine, ArrowUpFromLine, Shield, ArrowUpDown,
  Tag, User, CreditCard,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import DataTable from '../components/DataTable';
import Toolbar from '../components/Toolbar';
import TableFooter from '../components/TableFooter';
import EmptyState from '../components/EmptyState';
import FilterDropdown from '../components/FilterDropdown';
import ColumnsDropdown from '../components/ColumnsDropdown';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { rawVal, fmt, fmtAbbrev } from '@/app/lib/format';
import { parseCsvLines } from '../lib/csv';
import { getBusinessToday, toBusinessDate, parseCardCutoffDate } from '../lib/businessDate';
import {
  computeWalletStatus,
  WALLET_STATUS_OPTIONS,
  isLoggedIn,
  computeCompanyBalance,
  computeAgentWithdrawal,
  computeSdpVsBalance,
  resolveBrand,
} from '../lib/balanceEngine';
import { getPreference, setPreference } from '../lib/preferences';

type OpeningRow = {
  agentName: string;
  openingBal: string;
  sdp: string;
  leader: string;
};

type MergedRow = OpeningRow & {
  agentTotalDP: number;
  agentTotalWD: number;
  totalTopUp: number;
  totalStlm: number;
  balanceInside: number;
  runningBalance: number;
  agentWithdrawal: number;
  sdpVsBalance: number;
  walletStatus: string;
  brand: string;
  walletType: string;
};

function displayNum(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '−';

  let num: number;
  if (typeof val === 'number') {
    num = val;
  } else {
    const cleaned = val.replace(/"/g, '').replace(/,/g, '').trim();
    if (cleaned === '-' || cleaned === '') return '−';
    num = parseFloat(cleaned);
  }

  if (isNaN(num) || Math.abs(num) < 0.01) return '−';

  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${formatted}` : formatted;
}

function numOrBlank(num: number): number | undefined {
  return Math.abs(num) < 0.01 ? undefined : num;
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// Opening sheet col G holds a "REPORT LAST UPDATE" card, e.g. "July 2 - 8:54 AM".
// This is the cutoff: Top Up / Settlement totals should only include rows dated
// on or after this reset point, so entries already folded into the last Opening
// Balance reset aren't double-counted.
function parseReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const parsed = parseCardCutoffDate(row[6] ?? '');
    if (parsed) return parsed;
  }
  return null;
}

// Stlm Top Up sheet dates are formatted "M/D/YYYY".
function parseSheetDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

const WALLET_TYPE_ORDER = [
  { match: 'BKASH', abbreviation: 'BK' },
  { match: 'NAGAD', abbreviation: 'NG' },
  { match: 'ROCKET', abbreviation: 'RK' },
  { match: 'UPAY', abbreviation: 'UP' },
];

function computeWalletType(types: string[]): string {
  const normalized = new Set(types.map((raw) => raw.trim().toUpperCase()).filter((t) => t && t !== '-'));

  const abbreviations = WALLET_TYPE_ORDER
    .filter(({ match }) => normalized.has(match))
    .map(({ abbreviation }) => abbreviation);

  return abbreviations.length > 0 ? abbreviations.join(' | ') : '−';
}

const WALLET_TYPE_FILTER_OPTIONS = [
  { label: 'Bkash', abbreviation: 'BK' },
  { label: 'Nagad', abbreviation: 'NG' },
  { label: 'Rocket', abbreviation: 'RK' },
  { label: 'UPay', abbreviation: 'UP' },
];

const WALLET_TYPE_FILTER_LABELS = [...WALLET_TYPE_FILTER_OPTIONS.map((opt) => opt.label), '—'];

const EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE',
  'MUNIM', 'NIHJUM', 'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN',
  'ROSE', 'SAM', 'XYZ', 'SHAKIL', 'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR'
];

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

// "To Agent" values on "AG BD STLM + TOPUP" sometimes carry a trailing
// "-<brand>" suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") —
// strip it so the bare code matches Opening AG's own (always-bare) agent names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// Leader names come from the sheet in ALL CAPS — same helper as
// Settlement/Top Up's own toProperCase, display-only (sorting/filtering/
// export all still key off the raw value).
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's, per that file's own note.
const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  WALLET_NAME: 'walletName',
  WALLET_TYPE: 'walletType',
  SDP: 'sdp',
  OPENING: 'opening',
  TOTAL_DP: 'totalDP',
  TOTAL_WD: 'totalWD',
  TOP_UP: 'topUp',
  SETTLEMENT: 'settlement',
  COMPANY_BALANCE: 'companyBalance',
  BALANCE_INSIDE: 'balanceInside',
  AGENT_WITHDRAWAL: 'agentWithdrawal',
  SDP_VS_BALANCE: 'sdpVsBalance',
  WALLET_STATUS: 'walletStatus',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];

// Column model matches Settlement's ColumnDef shape ({key/label/visible/
// sortable/hideable/align} — `key` kept instead of Settlement's `id` since
// every existing reference on this page already reads `col.key`). None of
// this table's columns are a protected Actions-style column, so all are
// hideable; DEFAULT_HIDDEN below seeds which start hidden.
type ColumnDef = {
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

// All columns visible by default — Restore Defaults must always land on
// every column checked, none hidden.
const DEFAULT_HIDDEN: ColumnKey[] = [];

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.BRAND), sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.LEADER), sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_NAME, label: 'Shop Name', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.WALLET_NAME), sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_TYPE, label: 'Type', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.WALLET_TYPE), sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.SDP, label: 'SDP', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.SDP), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.OPENING, label: 'Opening', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.OPENING), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.TOTAL_DP, label: 'Total DP', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.TOTAL_DP), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.TOTAL_WD, label: 'Total WD', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.TOTAL_WD), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.TOP_UP, label: 'Top Up', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.TOP_UP), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.SETTLEMENT, label: 'Settlement', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.SETTLEMENT), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.COMPANY_BALANCE), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.BALANCE_INSIDE, label: 'Balance Inside', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.BALANCE_INSIDE), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.AGENT_WITHDRAWAL, label: 'Agent Withdrawal', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.AGENT_WITHDRAWAL), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.SDP_VS_BALANCE, label: 'SDP VS Balance', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.SDP_VS_BALANCE), sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: !DEFAULT_HIDDEN.includes(COLUMN_IDS.WALLET_STATUS), sortable: true, hideable: true, align: 'left' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'agentBalanceColumnVisibility';

const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.key, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

// Loading-skeleton bar widths — cycled by row index (not one fixed width
// per column) so consecutive rows read as varied, natural content rather
// than a repeated bar, matching Settlement/Top Up's own convention
// (AGENT_NAME_SKELETON_WIDTHS etc. in app/stlm/page.tsx). brand/walletStatus
// render their own pill-shaped skeleton instead (see the loading branch in
// the table body) since those are badges, not text/numbers.
const LEADER_SKELETON_WIDTHS = [55, 70, 85];
const SHOP_NAME_SKELETON_WIDTHS = [50, 65, 80];
const TYPE_SKELETON_WIDTHS = [40, 55, 70];
const AMOUNT_SKELETON_WIDTHS = [50, 60, 45, 55];

// This table is plain `table-auto` with no <colgroup> — every column is
// purely content-driven, none has an explicit width. Left alone, whichever
// row currently has the longest value in a given column stretches that
// column to fit it, and since auto-layout only ever looks at the rows
// CURRENTLY in the DOM, paginating/sorting/filtering to a page whose
// longest value differs re-triggers that stretch — every other column
// visibly shifts too (reported: "sobrang haba ng pangalan/value,
// nag-aadjust yung ibang column"). Fixing every column's own width to its
// longest real value across the FULL dataset (rows, not just the current
// page) removes that instability without converting the whole table to
// table-fixed/<colgroup>.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidthPx(text: string, font: string): number {
  if (typeof document === 'undefined') return 0;
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Fonts mirror each cell type's own real classes exactly: plain body text
// (text-[13px] font-normal), the header label (text-[13px] font-semibold),
// BrandBadge (text-[11px] font-semibold) and WalletStatusBadge
// (text-[11px] font-medium).
const BODY_TEXT_FONT = '400 13px Inter, sans-serif';
const HEADER_TEXT_FONT = '600 13px Inter, sans-serif';
const BRAND_BADGE_FONT = '600 11px Inter, sans-serif';
const WALLET_STATUS_BADGE_FONT = '500 11px Inter, sans-serif';

// px-5 cell padding = 20px each side = 40px total, on every cell.
const CELL_PADDING_PX = 40;
// Sort icon + its gap reserve, for sortable headers only (see SortIcon).
const HEADER_SORT_ICON_RESERVE_PX = 20;
// BrandBadge chrome beyond its text: px-2.5 (10px) each side + 1px border
// each side.
const BRAND_BADGE_CHROME_PX = 22;
// WalletStatusBadge chrome beyond its text: px-2 (8px) each side + 1px
// border each side + the status dot (6px) + its gap-1.5 (6px).
const WALLET_STATUS_BADGE_CHROME_PX = 30;
// Extra breathing room so the longest value never sits flush against the
// next column's edge.
const EXTRA_BREATHING_ROOM_PX = 8;

// Exact display string per column — mirrors renderCell's own per-column
// JSX content, kept as plain strings here purely for width measurement.
function getColumnDisplayText(row: MergedRow, key: ColumnKey): string {
  switch (key) {
    case 'brand': return row.brand;
    case 'leader': return toProperCase(row.leader);
    case 'walletName': return row.agentName;
    case 'walletType': return row.walletType;
    case 'sdp': return displayNum(row.sdp);
    case 'opening': return displayNum(row.openingBal);
    case 'totalDP': return displayNum(row.agentTotalDP);
    case 'totalWD': return displayNum(row.agentTotalWD);
    case 'topUp': return displayNum(row.totalTopUp);
    case 'settlement': return displayNum(row.totalStlm);
    case 'balanceInside': return displayNum(String(row.balanceInside ?? 0));
    case 'agentWithdrawal': return displayNum(String(row.agentWithdrawal));
    case 'sdpVsBalance': return row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−';
    case 'walletStatus': return row.walletStatus;
    case 'companyBalance':
    default: return displayNum(row.runningBalance);
  }
}

// For every visible column: measures the longest real value across the
// full dataset (plus each column's own badge chrome, where applicable),
// takes the max against the header label's own required width (so the
// label itself is never the thing that gets clipped), and returns a fixed
// px width to pin both the header and every body cell to.
function computeColumnWidthsPx(rows: MergedRow[], columns: ColumnDef[]): Partial<Record<ColumnKey, number>> {
  const result: Partial<Record<ColumnKey, number>> = {};
  for (const col of columns) {
    const font = col.key === 'brand' ? BRAND_BADGE_FONT
      : col.key === 'walletStatus' ? WALLET_STATUS_BADGE_FONT
      : BODY_TEXT_FONT;
    const chrome = col.key === 'brand' ? BRAND_BADGE_CHROME_PX
      : col.key === 'walletStatus' ? WALLET_STATUS_BADGE_CHROME_PX
      : 0;

    let maxTextWidth = 0;
    for (const row of rows) {
      const w = measureTextWidthPx(getColumnDisplayText(row, col.key) ?? '', font);
      if (w > maxTextWidth) maxTextWidth = w;
    }
    const dataWidth = maxTextWidth > 0 ? Math.ceil(maxTextWidth) + chrome + CELL_PADDING_PX + EXTRA_BREATHING_ROOM_PX : 0;

    const headerWidth = Math.ceil(measureTextWidthPx(col.label, HEADER_TEXT_FONT))
      + CELL_PADDING_PX
      + (col.sortable ? HEADER_SORT_ICON_RESERVE_PX : 0);

    const width = Math.max(dataWidth, headerWidth);
    if (width > 0) result[col.key] = width;
  }
  return result;
}

const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#E2E8F0] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

// Fixed display order for the mobile card's balances grid.
const BALANCE_GRID_ORDER: ColumnKey[] = [
  'balanceInside', 'agentWithdrawal', 'opening',
  'totalWD', 'topUp', 'totalDP',
  'settlement', 'sdp', 'sdpVsBalance',
];

// One consistent glyph everywhere (never swapped for a different shape) —
// active vs neutral is color-only, per explicit spec: "Keep using the SAME
// icon. Only rotate / change state internally. Do not swap icons."
function SortIcon({ active }: { active: boolean; direction: 'asc' | 'desc' }) {
  return (
    <ArrowUpDown
      size={12}
      className={active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}
    />
  );
}

function headerCellClasses(colKey: ColumnKey, _isSorted: boolean) {
  return `group overflow-hidden whitespace-nowrap px-5 text-${COLUMN_ALIGN[colKey]} text-[13px] font-semibold text-[#475569] dark:text-[#9CA3AF]`;
}

// Toolbar filter trigger — Brand/Leader/Wallet Type/Wallet Status. This is
// the pill button only; the panel beneath it is the shared, cross-page
// FilterDropdown component (app/components/FilterDropdown.tsx). Keeping the
// trigger page-local (rather than folding it into the shared component)
// lets other pages migrate to FilterDropdown later without being forced
// into this exact pill shape — the shared piece is the premium multi-select
// panel itself, not the button that opens it.
function FilterTriggerButton({
  label,
  icon: Icon,
  anyUnchecked,
  selectedCount,
  menuOpen,
  buttonRef,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  anyUnchecked: boolean;
  selectedCount: number;
  menuOpen: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] ${
        anyUnchecked
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-500/10 dark:text-indigo-300'
          : 'border-[#E5E7EB] bg-white text-[#475569] hover:bg-[#E2E8F0] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5'
      }`}
    >
      <Icon size={14} className={`transition-colors duration-150 ${anyUnchecked ? 'text-indigo-600 dark:text-indigo-400' : 'text-[#475569] dark:text-[#9CA3AF]'}`} />
      <span>{label}</span>
      {anyUnchecked && (
        <span className="flex h-4 min-w-[16px] animate-[dt-badge-pop_150ms_var(--ease-out-strong)] items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
          {selectedCount}
        </span>
      )}
      <ChevronDown
        size={14}
        className={`transition-[transform,color] duration-150 ease-[var(--ease-in-out-strong)] ${menuOpen ? 'rotate-180' : ''} ${anyUnchecked ? 'text-indigo-600 dark:text-indigo-400' : 'text-[#475569] dark:text-[#9CA3AF]'}`}
      />
    </button>
  );
}

function walletStatusBadgeClasses(status: string): string {
  switch (status) {
    case 'DP + WD':
    case 'DP Only':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/50';
    case 'WD Only':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/50';
    case 'Top Up Acc.':
      return 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-900/50';
    case 'Wallet With Issue':
    case 'Account Problem':
      return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-900/50';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
  }
}

function WalletStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletStatusBadgeClasses(status)}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {status}
    </span>
  );
}

// Per-code tint map for the Brand badge — reuses the same light-bg/border/
// text token pattern as walletStatusBadgeClasses, just keyed by BRAND_CODES
// instead of wallet status. Anything outside the known codes (e.g. '−')
// falls back to the same neutral slate default.
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
};

function brandBadgeClasses(brand: string): string {
  return BRAND_BADGE_TINTS[brand] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

function BrandBadge({ children }: { children: string }) {
  return (
    <span className={`inline-flex h-[26px] items-center rounded-md border px-2.5 text-[11px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${brandBadgeClasses(children)}`}>
      {children}
    </span>
  );
}

// Re-triggers a short opacity+translateY fade whenever `value` changes (e.g.
// after Refresh resolves with new numbers) — same pattern as
// SettlementSummary's own FadeValue, duplicated here since this page's KPI
// cards are bespoke, not built on that shared component.
function FadeValue({ value, className }: { value: string; className: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <p
      className={`${className} transition-[opacity,transform] duration-200 ease-out ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[5px]'
      }`}
    >
      {value}
    </p>
  );
}

// Mobile card grid fields — mirrors renderCell's data + colors, minus the
// columns (walletName, walletStatus, companyBalance) shown in the card header/hero.
function mobileCardFieldValue(row: MergedRow, key: ColumnKey): { value: string; className: string } {
  switch (key) {
    case 'brand':
      return { value: row.brand, className: 'text-foreground' };
    case 'leader':
      return { value: row.leader, className: 'text-muted-foreground' };
    case 'walletType':
      return { value: row.walletType, className: 'text-muted-foreground' };
    case 'sdp':
      return { value: displayNum(row.sdp), className: 'text-foreground' };
    case 'opening':
      return { value: displayNum(row.openingBal), className: 'text-foreground' };
    case 'totalDP': {
      const formatted = displayNum(row.agentTotalDP);
      return { value: formatted, className: formatted === '−' ? 'text-foreground' : 'text-emerald-600 dark:text-emerald-400' };
    }
    case 'totalWD': {
      const formatted = displayNum(row.agentTotalWD);
      const isZero = formatted === '−';
      return { value: isZero ? formatted : `-${formatted}`, className: isZero ? 'text-foreground' : 'text-rose-600 dark:text-rose-400' };
    }
    case 'topUp': {
      const formatted = displayNum(row.totalTopUp);
      return { value: formatted, className: formatted === '−' ? 'text-foreground' : 'text-emerald-600 dark:text-emerald-400' };
    }
    case 'settlement': {
      const formatted = displayNum(row.totalStlm);
      const isZero = formatted === '−';
      return { value: isZero ? formatted : `-${formatted}`, className: isZero ? 'text-foreground' : 'text-rose-600 dark:text-rose-400' };
    }
    case 'balanceInside':
      return { value: displayNum(String(row.balanceInside ?? 0)), className: 'text-foreground' };
    case 'agentWithdrawal':
      return { value: displayNum(String(row.agentWithdrawal)), className: 'text-foreground' };
    case 'sdpVsBalance':
      return { value: row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−', className: 'text-foreground' };
    default:
      return { value: '−', className: 'text-foreground' };
  }
}

function renderCell(row: MergedRow, key: ColumnKey, colWidthsPx?: Partial<Record<ColumnKey, number>>) {

  // Neutral text scheme matches Settlement's own renderCell base exactly
  // (app/stlm/page.tsx:686) — plain values carry no semantic color; only
  // Brand and Wallet Status stay as their own badge components. Total DP/
  // Total WD/Top Up/Settlement are the explicit exception (re-added per
  // later instruction): green for inflows (DP, Top Up), red + a leading
  // "-" for outflows (WD, Settlement — stored as positive magnitudes but
  // read as deductions), neutral whenever the value is zero/blank (the
  // em-dash). Company Balance stays fully neutral, no exception.
  const baseNoColor = `whitespace-nowrap px-5 py-[12px] text-${COLUMN_ALIGN[key]} text-[13px] leading-[20px] font-normal`;
  const base = `${baseNoColor} text-[#111827] dark:text-[#E5E7EB]`;
  // Every column gets the same fixed width treatment (see
  // computeColumnWidthsPx above) — not just Shop Name.
  const width = colWidthsPx?.[key];
  const cellStyle = width ? { width, minWidth: width } : undefined;

  switch (key) {
    case 'brand':
      return <td key={key} style={cellStyle} className={base}><BrandBadge>{row.brand}</BrandBadge></td>;
    case 'leader':
      return <td key={key} style={cellStyle} className={base}>{toProperCase(row.leader)}</td>;
    case 'walletName':
      return <td key={key} style={cellStyle} className={base}>{row.agentName}</td>;
    case 'walletType':
      return <td key={key} style={cellStyle} className={base}>{row.walletType}</td>;
    case 'sdp':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{displayNum(row.sdp)}</td>;
    case 'opening':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{displayNum(row.openingBal)}</td>;
    case 'totalDP': {
      const formatted = displayNum(row.agentTotalDP);
      const color = formatted === '−' ? 'text-[#111827] dark:text-[#E5E7EB]' : 'text-emerald-600 dark:text-emerald-400';
      return <td key={key} style={cellStyle} className={`${baseNoColor} tabular-nums ${color}`}>{formatted}</td>;
    }
    case 'totalWD': {
      const formatted = displayNum(row.agentTotalWD);
      const isZero = formatted === '−';
      const color = isZero ? 'text-[#111827] dark:text-[#E5E7EB]' : 'text-rose-600 dark:text-rose-400';
      return <td key={key} style={cellStyle} className={`${baseNoColor} tabular-nums ${color}`}>{isZero ? formatted : `-${formatted}`}</td>;
    }
    case 'topUp': {
      const formatted = displayNum(row.totalTopUp);
      const color = formatted === '−' ? 'text-[#111827] dark:text-[#E5E7EB]' : 'text-emerald-600 dark:text-emerald-400';
      return <td key={key} style={cellStyle} className={`${baseNoColor} tabular-nums ${color}`}>{formatted}</td>;
    }
    case 'settlement': {
      const formatted = displayNum(row.totalStlm);
      const isZero = formatted === '−';
      const color = isZero ? 'text-[#111827] dark:text-[#E5E7EB]' : 'text-rose-600 dark:text-rose-400';
      return <td key={key} style={cellStyle} className={`${baseNoColor} tabular-nums ${color}`}>{isZero ? formatted : `-${formatted}`}</td>;
    }
    case 'balanceInside':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{displayNum(String(row.balanceInside ?? 0))}</td>;
    case 'agentWithdrawal':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{displayNum(String(row.agentWithdrawal))}</td>;
    case 'sdpVsBalance':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−'}</td>;
    case 'walletStatus':
      return <td key={key} style={cellStyle} className={base}><WalletStatusBadge status={row.walletStatus} /></td>;
    case 'companyBalance': {
      const color = row.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-[#111827] dark:text-[#E5E7EB]';
      return <td key={key} style={cellStyle} className={`${baseNoColor} tabular-nums ${color}`}>{displayNum(row.runningBalance)}</td>;
    }
    default:
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{displayNum(row.runningBalance)}</td>;
  }
}

export default function AgentBalance() {
  const [rows, setRows] = useState<MergedRow[]>([]);

  // Fixed width per column — sized to each column's own longest real value
  // across the FULL dataset (rows, not the current page/search/sort
  // slice), so every column stays constant no matter which rows are on
  // screen. See computeColumnWidthsPx above for why this can't just be a
  // CSS min-width. Computed over DEFAULT_COLUMNS (not visibleColumns) so it
  // never depends on columnDefs' own declaration order below.
  const colWidthsPx = useMemo(() => computeColumnWidthsPx(rows, DEFAULT_COLUMNS), [rows]);

  const [loading, setLoading] = useState(true);
  // Skeleton -> real data is a real two-step cross-fade, not an instant
  // swap: the skeleton fades OUT in place for 120ms (same tbody node, so
  // the opacity transition actually plays), then real rows replace it and
  // fade IN over 200ms. Refreshing (loading flips back true) snaps
  // straight back to the skeleton — only the appearance of data needs the
  // soft landing. Matches Settlement's own established pattern.
  const [rowsPhase, setRowsPhase] = useState<'skeleton' | 'fadingOut' | 'table'>('skeleton');
  useEffect(() => {
    if (loading) {
      setRowsPhase('skeleton');
      return;
    }
    setRowsPhase('fadingOut');
    const timeout = setTimeout(() => setRowsPhase('table'), 120);
    return () => clearTimeout(timeout);
  }, [loading]);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [walletTypeFilter, setWalletTypeFilter] = useState<Record<string, boolean>>({});
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [walletTypeMenuOpen, setWalletTypeMenuOpen] = useState(false);
  const [walletStatusMenuOpen, setWalletStatusMenuOpen] = useState(false);

  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);

  const [walletStatusFilter, setWalletStatusFilter] = useState<Record<string, boolean>>(
    () => Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, true]))
  );
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const walletTypeButtonRef = useRef<HTMLButtonElement>(null);
  const walletStatusButtonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<number>(0);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      setIsScrolled(el.scrollTop > 0);
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

  const toggleRowSelection = useCallback((agentName: string) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(agentName)) {
        next.delete(agentName);
      } else {
        next.add(agentName);
      }
      return next;
    });
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
    setPage(1);
  }, []);

  const clearAllFilters = useCallback(() => {
    setSearchTerm('');
    setLeaderFilter({});
    setBrandFilter({});
    setWalletTypeFilter({});
    setWalletStatusFilter(Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, true])));
  }, []);

  const fetchData = useCallback(async () => {
    scrollRef.current = window.scrollY;
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [openingRes, balRes, stlmRes, estimatedRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/balance-limit?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/opening/estimated-balance?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, estimatedRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();
      const estimatedData: { balances: Record<string, number>; uploadedAt: string | null } = await estimatedRes.json();

      const openingRawRows = parseCsvLines(openingText);
      // Opening's own "Updated Time" card — kept separate from the Top
      // Up/Settlement cutoff below (which is purely clock-based). This one
      // is still needed to detect whether Opening AG has been manually
      // refreshed yet, for the Assumed Balance validity check further down.
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);
      // Top Up/Settlement totals (feeding Company Balance) reset at the 2AM
      // business-day rollover (see app/lib/businessDate.ts) — clock-based,
      // independent of whether Opening's own "Updated Time" card has been
      // manually refreshed.
      const topUpSettlementCutoff = getBusinessToday();

      // Assumed Balance (uploaded via Opening's "Upload Excel Data") only
      // takes over when BOTH hold:
      // 1. Opening's own "Updated Time" card is still showing the PREVIOUS
      //    business day — i.e. the real Opening reset for today hasn't
      //    happened yet. The instant "Updated Time" catches up to today,
      //    this stops applying on its own (no manual delete needed).
      // 2. The upload's OWN "Last Updated" timestamp is itself from TODAY's
      //    business day — a fresh upload made right around/after the 2AM
      //    rollover reads as "today" already (see app/lib/businessDate.ts).
      //    An upload left over from a prior business day (stale — no fresh
      //    file was uploaded for today) must NOT keep being applied just
      //    because Opening's own reset happens to be running late too.
      const estimatedUploadedAt = estimatedData.uploadedAt ? new Date(estimatedData.uploadedAt) : null;
      const estimatedOpeningValid =
        reportCutoffDate !== null &&
        reportCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedUploadedAt !== null &&
        toBusinessDate(estimatedUploadedAt).getTime() === getBusinessToday().getTime();
      const estimatedBalances = new Map(Object.entries(estimatedData.balances ?? {}));

      const openingRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          openingBal: rawVal(row[1]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD')
        .map((row) => {
          if (!estimatedOpeningValid) return row;
          const assumedBalance = estimatedBalances.get(row.agentName);
          return assumedBalance === undefined ? row : { ...row, openingBal: String(assumedBalance) };
        });

      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[1]),
          walletType: rawVal(row[4]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          balance: rawVal(row[8]),
          login: rawVal(row[15]),
          accountStatus: rawVal(row[2]),
          group: rawVal(row[6]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      const walletStatusValues = new Map<string, string[]>();
      const brandGroups = new Map<string, string[]>();
      const walletTypeValues = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
        balanceTotals.set(name, {
          dp: existing.dp + dp,
          wd: existing.wd + wd,
        });

        if (bal.group && bal.group !== '-') {
          const groups = brandGroups.get(name) ?? [];
          groups.push(bal.group);
          brandGroups.set(name, groups);
        }

        if (bal.accountStatus && bal.accountStatus !== '-') {
          const statuses = walletStatusValues.get(name) ?? [];
          statuses.push(bal.accountStatus);
          walletStatusValues.set(name, statuses);
        }

        if (bal.walletType && bal.walletType !== '-' && isLoggedIn(bal.login)) {
          const types = walletTypeValues.get(name) ?? [];
          types.push(bal.walletType);
          walletTypeValues.set(name, types);
        }

        if (isLoggedIn(bal.login)) {
          const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
        }
      });

      // "AG BD STLM + TOPUP" is Cashout's own dedicated Settlement + Top Up
      // sheet (replaces the old shared "Stlm Top Up" source). Top Up lives
      // in cols B-F (indices 1-5): To Agent/Amount/Date/Wallet/Type (the
      // sheet's own header row mislabels cols D/E as "Wallet"/"Date" — the
      // actual data order matches this, confirmed by sampling), amounts
      // stored positive. Settlement lives in cols H-L (indices 7-11), same
      // field order, amounts stored negative (money leaving) so they're
      // abs()'d. Cols Q-AA are a last-month archive and are not read.
      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = stripBrandSuffix(rawVal(row[1]));
          const topUpAmount = rawVal(row[2]);
          const topUpDate = parseSheetDate(rawVal(row[3]));
          if (
            topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
            topUpDate && topUpDate >= topUpSettlementCutoff
          ) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = stripBrandSuffix(rawVal(row[7]));
          const stlmAmount = rawVal(row[8]);
          const stlmDate = parseSheetDate(rawVal(row[9]));
          if (
            stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
            stlmDate && stlmDate >= topUpSettlementCutoff
          ) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: MergedRow[] = openingRows.map((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
        const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
        const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
        const runningBalance = computeCompanyBalance(parseNumber(opening.openingBal), totals.dp, totalTopUp, totals.wd, totalStlm);
        const sdpNum = parseNumber(opening.sdp);
        const walletStatus = balWalletNames.has(opening.agentName)
          ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
          : 'No Record';
        return {
          ...opening,
          agentTotalDP: totals.dp,
          agentTotalWD: totals.wd,
          totalTopUp,
          totalStlm,
          balanceInside,
          runningBalance,
          agentWithdrawal: computeAgentWithdrawal(runningBalance, balanceInside),
          sdpVsBalance: computeSdpVsBalance(opening.leader, opening.sdp, sdpNum, runningBalance, EXCLUDED_SDP_LEADERS),
          walletStatus,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES }),
          walletType: computeWalletType(walletTypeValues.get(opening.agentName) ?? []),
        };
      });

      setRows(merged);
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.scrollTo({ top: scrollRef.current, behavior: 'instant' });
          });
        });
      }, 50);
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
  }, [searchTerm, leaderFilter, brandFilter, walletStatusFilter, walletTypeFilter, sortColumn, sortDirection]);

  useEffect(() => {
    setMounted(true);
    const saved = getPreference<Record<string, boolean> | null>(COLUMN_VISIBILITY_STORAGE_KEY, null);
    if (!saved) return;
    setColumnDefs((current) =>
      current.map((col) => (col.key in saved ? { ...col, visible: saved[col.key] } : col))
    );
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const visibility = Object.fromEntries(columnDefs.map((col) => [col.key, col.visible])) as Record<ColumnKey, boolean>;
    setPreference(COLUMN_VISIBILITY_STORAGE_KEY, visibility);
  }, [columnDefs, mounted]);

  // Gated on `mounted` so the very first paint never shows the all-visible
  // DEFAULT_COLUMNS set before the saved preference has been read (same
  // reload-flash fix as Settlement's).
  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );
  // Backward-compatible lookup so existing `columnVisibility[key]`/`.key`
  // reads elsewhere in this file (mobile card view, etc.) keep working
  // unchanged against the new stateful columnDefs.
  const columnVisibility = useMemo(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, col.visible])) as Record<ColumnKey, boolean>,
    [columnDefs]
  );

  const walletStatusOptions = useMemo(() => {
    const present = new Set(rows.map((row) => row.walletStatus));
    return WALLET_STATUS_OPTIONS.filter((status) => present.has(status));
  }, [rows]);

  const anyWalletStatusUnchecked = walletStatusOptions.some((status) => !walletStatusFilter[status]);
  const selectedWalletStatusCount = walletStatusOptions.filter((status) => walletStatusFilter[status]).length;

  const leaderOptions = useMemo(() => {
    const leaders = Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return leaders;
  }, [rows]);

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;

  const brandOptions = useMemo(() => {
    const brands = Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return brands;
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const walletTypeOptions = WALLET_TYPE_FILTER_LABELS;

  const isWalletTypeChecked = (name: string) => walletTypeFilter[name] !== false;
  const anyWalletTypeUnchecked = walletTypeOptions.some((name) => !isWalletTypeChecked(name));
  const selectedWalletTypeCount = walletTypeOptions.filter((name) => isWalletTypeChecked(name)).length;

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return rows;

    return rows.filter((row) => {
      const haystack = `${row.leader} ${row.agentName} ${row.openingBal} ${row.sdp}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, searchTerm]);

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletStatusOptions.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) {
      list = list.filter((row) => {
        if (row.walletType === '−') return isWalletTypeChecked('—');
        const rowAbbreviations = row.walletType.split(' | ');
        return WALLET_TYPE_FILTER_OPTIONS.some(
          (opt) => rowAbbreviations.includes(opt.abbreviation) && isWalletTypeChecked(opt.label)
        );
      });
    }
    return list;
  }, [leaderFilter, leaderOptions, brandFilter, brandOptions, walletStatusFilter, walletTypeFilter, walletTypeOptions, searchedRows]);

  // Faceted option counts for the 4 filter dropdowns — same "other filters +
  // search" composition as filteredRows above, each omitting its own facet's
  // clause so unchecking an option doesn't shrink its own list toward zero.
  // Presentation-only tallies; filteredRows itself (the real table filter)
  // is untouched.
  const leaderFacetRows = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletStatusOptions.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) {
      list = list.filter((row) => {
        if (row.walletType === '−') return isWalletTypeChecked('—');
        const rowAbbreviations = row.walletType.split(' | ');
        return WALLET_TYPE_FILTER_OPTIONS.some(
          (opt) => rowAbbreviations.includes(opt.abbreviation) && isWalletTypeChecked(opt.label)
        );
      });
    }
    return list;
  }, [searchedRows, brandFilter, brandOptions, walletStatusFilter, walletStatusOptions, walletTypeFilter, walletTypeOptions]);

  const leaderFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of leaderFacetRows) {
      counts.set(row.leader, (counts.get(row.leader) ?? 0) + 1);
    }
    return leaderOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [leaderFacetRows, leaderOptions]);

  const brandFacetRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (walletStatusOptions.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) {
      list = list.filter((row) => {
        if (row.walletType === '−') return isWalletTypeChecked('—');
        const rowAbbreviations = row.walletType.split(' | ');
        return WALLET_TYPE_FILTER_OPTIONS.some(
          (opt) => rowAbbreviations.includes(opt.abbreviation) && isWalletTypeChecked(opt.label)
        );
      });
    }
    return list;
  }, [searchedRows, leaderFilter, leaderOptions, walletStatusFilter, walletStatusOptions, walletTypeFilter, walletTypeOptions]);

  const brandFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of brandFacetRows) {
      counts.set(row.brand, (counts.get(row.brand) ?? 0) + 1);
    }
    return brandOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [brandFacetRows, brandOptions]);

  const walletStatusFacetRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) {
      list = list.filter((row) => {
        if (row.walletType === '−') return isWalletTypeChecked('—');
        const rowAbbreviations = row.walletType.split(' | ');
        return WALLET_TYPE_FILTER_OPTIONS.some(
          (opt) => rowAbbreviations.includes(opt.abbreviation) && isWalletTypeChecked(opt.label)
        );
      });
    }
    return list;
  }, [searchedRows, leaderFilter, leaderOptions, brandFilter, brandOptions, walletTypeFilter, walletTypeOptions]);

  const walletStatusFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of walletStatusFacetRows) {
      counts.set(row.walletStatus, (counts.get(row.walletStatus) ?? 0) + 1);
    }
    return walletStatusOptions.map((status) => ({ value: status, label: status, count: counts.get(status) ?? 0 }));
  }, [walletStatusFacetRows, walletStatusOptions]);

  const walletTypeFacetRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletStatusOptions.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    return list;
  }, [searchedRows, leaderFilter, leaderOptions, brandFilter, brandOptions, walletStatusFilter, walletStatusOptions]);

  const walletTypeFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of walletTypeFacetRows) {
      if (row.walletType === '−') {
        counts.set('—', (counts.get('—') ?? 0) + 1);
        continue;
      }
      const rowAbbreviations = row.walletType.split(' | ');
      for (const opt of WALLET_TYPE_FILTER_OPTIONS) {
        if (rowAbbreviations.includes(opt.abbreviation)) {
          counts.set(opt.label, (counts.get(opt.label) ?? 0) + 1);
        }
      }
    }
    return walletTypeOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [walletTypeFacetRows, walletTypeOptions]);

  // Unified 5-card KPI row — Total DP, Total WD, SDP, Actual Balance, Running
  // Balance all rendered at equal size in one row (per explicit instruction,
  // replacing the earlier "2 hero + 3 secondary" split). Total DP/WD/SDP show
  // the full precise figure as their subtitle (matching Actual Balance's own
  // subtitle-line treatment); Actual/Running Balance keep their descriptive
  // text. Only Running Balance carries a trend arrow.
  const kpis = useMemo(() => {
    const totalDP = filteredRows.reduce((sum, row) => sum + row.agentTotalDP, 0);
    const totalWD = filteredRows.reduce((sum, row) => sum + row.agentTotalWD, 0);
    const totalSdp = filteredRows.reduce((sum, row) => sum + parseNumber(row.sdp), 0);
    const totalBalanceInside = filteredRows.reduce((sum, row) => sum + row.balanceInside, 0);
    const totalRunningBalance = filteredRows.reduce((sum, row) => sum + row.runningBalance, 0);
    const totalOpening = filteredRows.reduce((sum, row) => sum + parseNumber(row.openingBal), 0);
    const runningVsOpening = totalRunningBalance - totalOpening;

    return [
      {
        label: 'Total DP',
        icon: ArrowDownToLine,
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-50 dark:bg-emerald-500/10',
        bigValue: fmtAbbrev(totalDP),
        subtitle: fmt(totalDP),
        trend: undefined as 'up' | 'down' | undefined,
      },
      {
        label: 'Total WD',
        icon: ArrowUpFromLine,
        accent: 'text-rose-600 dark:text-rose-400',
        iconBg: 'bg-rose-50 dark:bg-rose-500/10',
        bigValue: fmtAbbrev(totalWD),
        subtitle: fmt(totalWD),
        trend: undefined as 'up' | 'down' | undefined,
      },
      {
        label: 'SDP',
        icon: Shield,
        accent: 'text-slate-500 dark:text-slate-400',
        iconBg: 'bg-slate-100 dark:bg-slate-500/10',
        bigValue: fmtAbbrev(totalSdp),
        subtitle: fmt(totalSdp),
        trend: undefined as 'up' | 'down' | undefined,
      },
      {
        label: 'Actual Balance',
        icon: Wallet,
        accent: 'text-blue-600 dark:text-blue-400',
        iconBg: 'bg-blue-50 dark:bg-blue-500/10',
        bigValue: fmtAbbrev(totalBalanceInside),
        subtitle: 'Current available balance',
        trend: undefined as 'up' | 'down' | undefined,
      },
      {
        label: 'Running Balance',
        icon: TrendingUp,
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-50 dark:bg-emerald-500/10',
        bigValue: fmtAbbrev(totalRunningBalance),
        subtitle: `${runningVsOpening >= 0 ? '+' : '-'}${fmtAbbrev(Math.abs(runningVsOpening))} vs Opening`,
        trend: (runningVsOpening >= 0 ? 'up' : 'down') as 'up' | 'down' | undefined,
      },
    ];
  }, [filteredRows]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: typeof a, column: ColumnKey) => {
        switch (column) {
          case 'brand':
            return row.brand.toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'walletName':
            return row.agentName.toLowerCase();
          case 'walletType':
            return row.walletType.toLowerCase();
          case 'sdp':
            return parseNumber(row.sdp);
          case 'opening':
            return parseNumber(row.openingBal);
          case 'totalDP':
            return row.agentTotalDP;
          case 'totalWD':
            return row.agentTotalWD;
          case 'topUp':
            return row.totalTopUp;
          case 'settlement':
            return row.totalStlm;
          case 'balanceInside':
            return row.balanceInside;
          case 'agentWithdrawal':
            return row.agentWithdrawal;
          case 'sdpVsBalance':
            return row.sdpVsBalance;
          case 'walletStatus':
            return row.walletStatus.toLowerCase();
          case 'companyBalance':
          default:
            return row.runningBalance;
        }
      };

      const valueA = getValue(a, sortColumn);
      const valueB = getValue(b, sortColumn);

      if (sortColumn === 'walletName' || sortColumn === 'walletType' || sortColumn === 'leader' || sortColumn === 'walletStatus' || sortColumn === 'brand') {
        const comparison = String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
        return sortDirection === 'asc' ? comparison : -comparison;
      }

      const comparison = Number(valueA) - Number(valueB);
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return list;
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  const handleExport = useCallback(() => {
    const getExportValue = (row: MergedRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand;
        case 'leader':
          return row.leader;
        case 'walletName':
          return row.agentName;
        case 'walletType':
          return row.walletType;
        case 'sdp':
          return numOrBlank(parseNumber(row.sdp));
        case 'opening':
          return numOrBlank(parseNumber(row.openingBal));
        case 'totalDP':
          return numOrBlank(row.agentTotalDP);
        case 'totalWD':
          return numOrBlank(row.agentTotalWD);
        case 'topUp':
          return numOrBlank(row.totalTopUp);
        case 'settlement':
          return numOrBlank(row.totalStlm);
        case 'companyBalance':
          return numOrBlank(row.runningBalance);
        case 'balanceInside':
          return numOrBlank(row.balanceInside);
        case 'agentWithdrawal':
          return numOrBlank(row.agentWithdrawal);
        case 'sdpVsBalance':
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined;
        case 'walletStatus':
          return row.walletStatus;
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Agent Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_BALANCES_SUMMARY_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <SettlementHeader
        icon={Wallet}
        title="Balance"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />

      {!error && (
        <div className="w-full border-t border-border bg-[#f4f6fb] px-4 py-3 dark:bg-[#1c1c1e] md:px-6">
          <div className="flex gap-2">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 dark:bg-[#2a2a2d]">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 shrink-0 dt-skeleton rounded-full" />
                    <div className="min-w-0 flex-1">
                      <div className="h-3 w-20 dt-skeleton rounded-md" />
                      <div className="mt-1.5 h-6 w-24 dt-skeleton rounded-md" />
                      <div className="mt-1 h-3 w-28 dt-skeleton rounded-md" />
                    </div>
                  </div>
                </div>
              ))
            ) : (
              kpis.map((kpi, i) => (
                <div
                  key={kpi.label}
                  style={{ animationDelay: `${i * 25}ms`, animationFillMode: 'backwards' }}
                  className="dt-step-fade-in flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm dark:bg-[#2a2a2d]"
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${kpi.iconBg}`}>
                      <kpi.icon size={16} className={kpi.accent} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium leading-snug text-muted-foreground truncate">{kpi.label}</p>
                      <FadeValue value={kpi.bigValue} className={`font-bold leading-tight text-foreground ${kpi.subtitle ? 'text-[21px]' : 'text-[28px]'}`} />
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-snug text-muted-foreground truncate">
                        {kpi.trend === 'up' && <span className="text-emerald-600 dark:text-emerald-400">▲</span>}
                        {kpi.trend === 'down' && <span className="text-rose-600 dark:text-rose-400">▼</span>}
                        {kpi.subtitle}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-1">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            <Toolbar>
              <Toolbar.Left>
                <div className="flex h-10 w-full min-w-[200px] items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-[14px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] sm:w-[400px]">
                  {loading ? (
                    <div className="h-3 w-32 dt-skeleton rounded-md" />
                  ) : (
                    <>
                      <Search size={14} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
                      <input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[13px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
                        placeholder="Search for anything"
                      />
                    </>
                  )}
                </div>
                {loading && (
                  <>
                    <div className="h-9 w-[92px] shrink-0 dt-skeleton rounded-full" />
                    <div className="h-9 w-[98px] shrink-0 dt-skeleton rounded-full" />
                    <div className="h-9 w-[130px] shrink-0 dt-skeleton rounded-full" />
                    <div className="h-9 w-[140px] shrink-0 dt-skeleton rounded-full" />
                  </>
                )}
                {!loading && (
                  <>
                    <div className="relative">
                      <FilterTriggerButton
                        label="Brand"
                        icon={Tag}
                        anyUnchecked={anyBrandUnchecked}
                        selectedCount={selectedBrandCount}
                        menuOpen={brandMenuOpen}
                        buttonRef={brandButtonRef}
                        onClick={() => setBrandMenuOpen((current) => !current)}
                      />
                      <FilterDropdown
                        open={brandMenuOpen}
                        onOpenChange={setBrandMenuOpen}
                        anchorRef={brandButtonRef}
                        options={brandFilterOptions}
                        selected={brandFilter}
                        onChange={setBrandFilter}
                      />
                    </div>
                    <div className="relative">
                      <FilterTriggerButton
                        label="Leader"
                        icon={User}
                        anyUnchecked={anyLeaderUnchecked}
                        selectedCount={selectedLeaderCount}
                        menuOpen={leaderMenuOpen}
                        buttonRef={leaderButtonRef}
                        onClick={() => setLeaderMenuOpen((current) => !current)}
                      />
                      <FilterDropdown
                        open={leaderMenuOpen}
                        onOpenChange={setLeaderMenuOpen}
                        anchorRef={leaderButtonRef}
                        options={leaderFilterOptions}
                        selected={leaderFilter}
                        onChange={setLeaderFilter}
                      />
                    </div>
                    <div className="relative">
                      <FilterTriggerButton
                        label="Wallet Type"
                        icon={CreditCard}
                        anyUnchecked={anyWalletTypeUnchecked}
                        selectedCount={selectedWalletTypeCount}
                        menuOpen={walletTypeMenuOpen}
                        buttonRef={walletTypeButtonRef}
                        onClick={() => setWalletTypeMenuOpen((current) => !current)}
                      />
                      <FilterDropdown
                        open={walletTypeMenuOpen}
                        onOpenChange={setWalletTypeMenuOpen}
                        anchorRef={walletTypeButtonRef}
                        options={walletTypeFilterOptions}
                        selected={walletTypeFilter}
                        onChange={setWalletTypeFilter}
                      />
                    </div>
                    <div className="relative">
                      <FilterTriggerButton
                        label="Wallet Status"
                        icon={Shield}
                        anyUnchecked={anyWalletStatusUnchecked}
                        selectedCount={selectedWalletStatusCount}
                        menuOpen={walletStatusMenuOpen}
                        buttonRef={walletStatusButtonRef}
                        onClick={() => setWalletStatusMenuOpen((current) => !current)}
                      />
                      <FilterDropdown
                        open={walletStatusMenuOpen}
                        onOpenChange={setWalletStatusMenuOpen}
                        anchorRef={walletStatusButtonRef}
                        options={walletStatusFilterOptions}
                        selected={walletStatusFilter}
                        onChange={setWalletStatusFilter}
                      />
                    </div>
                  </>
                )}
              </Toolbar.Left>
              <Toolbar.Right>
                {loading && (
                  <>
                    <div className="h-9 w-[92px] shrink-0 dt-skeleton rounded-[8px]" />
                    <div className="h-9 w-[88px] shrink-0 dt-skeleton rounded-[8px]" />
                    <div className="h-9 w-[108px] shrink-0 dt-skeleton rounded-[8px]" />
                  </>
                )}
                {!loading && (
                  <>
                    <button type="button" onClick={fetchData} aria-label="Refresh" className={GHOST_BUTTON}>
                      <RefreshCw size={14} className={spinning ? 'animate-spin' : ''} />
                      <span>Refresh</span>
                    </button>
                    <button type="button" onClick={handleExport} aria-label="Export to Excel" className={GHOST_BUTTON}>
                      <Download size={14} />
                      <span>Export</span>
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        ref={columnsButtonRef}
                        onClick={() => setColumnsMenuOpen((current) => !current)}
                        aria-haspopup="true"
                        aria-expanded={columnsMenuOpen}
                        aria-controls="agentbal-columns-popover"
                        aria-label="Columns"
                        className={GHOST_BUTTON}
                      >
                        <Columns3 size={14} />
                        <span>Columns</span>
                        <ChevronDown size={14} className={`transition-transform duration-150 ease-[var(--ease-in-out-strong)] ${columnsMenuOpen ? 'rotate-180' : ''}`} />
                      </button>
                      <ColumnsDropdown
                        id="agentbal-columns-popover"
                        open={columnsMenuOpen}
                        onOpenChange={setColumnsMenuOpen}
                        anchorRef={columnsButtonRef}
                        columns={columnDefs}
                        onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))}
                        onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                      />
                    </div>
                  </>
                )}
              </Toolbar.Right>
            </Toolbar>
            <div className="relative hidden flex-1 min-h-0 sm:block">
              <div
                ref={tableScrollRef}
                className={`dt-scroll agentbal-scroll h-full ${
                  loading ? 'overflow-hidden pointer-events-none' : 'overflow-y-auto overflow-x-auto pointer-events-auto'
                }`}
              >
              <table className="w-full text-xs">
                <thead className={`sticky top-0 z-[50] bg-[#FAFBFC] dark:bg-[#1C1F26] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[48px]">
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={colWidthsPx[col.key] ? { width: colWidthsPx[col.key], minWidth: colWidthsPx[col.key] } : undefined}
                        className={headerCellClasses(col.key, sortColumn === col.key)}>
                        {/* Header always renders its real label/sort control,
                            loading or not — only data rows shimmer (premium
                            skeleton spec: headers are never placeholders,
                            matching Settlement/Top Up's own convention). */}
                        {col.sortable ? (
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
                            className={`group/sort flex w-full items-center whitespace-nowrap transition-[opacity,transform] duration-150 ease-out hover:opacity-80 active:scale-[0.98] ${
                              col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : 'justify-start gap-1.5'
                            }`}
                          >
                            {col.align === 'right' || col.align === 'center' ? (
                              // Right/center-aligned columns: the label sits in
                              // its own relatively-positioned wrapper sized to
                              // its own text only, so justify-end/center
                              // aligns THAT (the label alone) — matching where
                              // the data below it lines up. The icon is
                              // pulled out with position:absolute so it never
                              // contributes to the wrapper's width; without
                              // this, the icon (not the label) ends up at the
                              // true right/center edge, leaving the label
                              // text itself misaligned with the data under it
                              // (verified live: icon's edge matched the data
                              // column's edge exactly, label's did not).
                              <span className="relative inline-flex items-center">
                                {col.label}
                                <span className={`absolute left-full ml-1.5 flex items-center ${sortColumn === col.key ? '' : 'opacity-60 transition-opacity duration-150 group-hover/sort:opacity-100'}`}>
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              </span>
                            ) : (
                              <>
                                <span>{col.label}</span>
                                <span className={sortColumn === col.key ? '' : 'opacity-60 transition-opacity duration-150 group-hover/sort:opacity-100'}>
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              </>
                            )}
                          </button>
                        ) : (
                          col.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody
                  className={
                    rowsPhase === 'table'
                      ? 'opacity-100 transition-opacity duration-200 ease-out'
                      : rowsPhase === 'fadingOut'
                      ? 'opacity-0 transition-opacity duration-[120ms] ease-out'
                      : 'opacity-100'
                  }
                >
                  {rowsPhase !== 'table' ? Array.from({ length: 18 }).map((_, i) => (
                    <tr key={i}>
                      {visibleColumns.map((col) => (
                        <td
                          key={col.key}
                          style={colWidthsPx[col.key] ? { width: colWidthsPx[col.key], minWidth: colWidthsPx[col.key] } : undefined}
                          className="px-5 py-[12px]"
                        >
                          {col.key === 'brand' ? (
                            <div className="h-[26px] w-12 dt-skeleton rounded-md" />
                          ) : col.key === 'walletStatus' ? (
                            <div className="h-5 w-20 dt-skeleton rounded-md" />
                          ) : col.key === 'leader' ? (
                            <div className="h-2.5 dt-skeleton rounded-md" style={{ width: `${LEADER_SKELETON_WIDTHS[i % LEADER_SKELETON_WIDTHS.length]}%` }} />
                          ) : col.key === 'walletName' ? (
                            <div className="h-2.5 dt-skeleton rounded-md" style={{ width: `${SHOP_NAME_SKELETON_WIDTHS[i % SHOP_NAME_SKELETON_WIDTHS.length]}%` }} />
                          ) : col.key === 'walletType' ? (
                            <div className="h-2.5 dt-skeleton rounded-md" style={{ width: `${TYPE_SKELETON_WIDTHS[i % TYPE_SKELETON_WIDTHS.length]}%` }} />
                          ) : (
                            <div className="h-2.5 dt-skeleton rounded-md" style={{ width: `${AMOUNT_SKELETON_WIDTHS[i % AMOUNT_SKELETON_WIDTHS.length]}%` }} />
                          )}
                        </td>
                      ))}
                    </tr>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    const isSelected = selectedRows.has(row.agentName);
                    return (
                      <tr
                        key={row.agentName || i}
                        onClick={() => toggleRowSelection(row.agentName)}
                        className={`border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32] transition-colors duration-150 ease-out ${
                          isSelected
                            ? 'bg-[color:var(--product-accent-soft)] shadow-[inset_4px_0_0_var(--product-accent)]'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        {visibleColumns.map((col) => renderCell(row, col.key, colWidthsPx))}
                      </tr>
                    );
                  }) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)}>
                        <EmptyState
                          title="No matching accounts found"
                          description="Try adjusting your search or filters."
                          action={
                            <button type="button" onClick={clearAllFilters} className={GHOST_BUTTON}>
                              Clear Filters
                            </button>
                          }
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
              {!loading && (
                <div className="pointer-events-none absolute inset-y-0 left-0 z-[55] w-6 bg-gradient-to-r from-white to-transparent dark:from-[#2a2a2d]" />
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto sm:hidden">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="h-4 w-2/3 dt-skeleton rounded-md" />
                      <div className="mt-2 h-3 w-1/3 dt-skeleton rounded-md" />
                      <div className="mt-3 h-6 w-1/2 dt-skeleton rounded-md" />
                    </div>
                  ))
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => {
                    const showName = columnVisibility.walletName;
                    const showBrand = columnVisibility.brand;
                    const showStatus = columnVisibility.walletStatus;
                    const showBalance = columnVisibility.companyBalance;
                    const subtitle = [
                      columnVisibility.leader ? toProperCase(row.leader) : null,
                      columnVisibility.walletType && row.walletType !== '−' ? row.walletType : null,
                    ].filter(Boolean).join(' · ');
                    const hasHeader = showName || showBrand || showStatus || !!subtitle;

                    const gridFields = BALANCE_GRID_ORDER.filter((key) => columnVisibility[key]);

                    return (
                      <div key={row.agentName || i} className="rounded-xl border-[0.5px] border-border bg-white p-4 dark:bg-[#2a2a2d]">
                        {hasHeader && (
                          <div className="flex items-start justify-between gap-2 border-b border-border pb-3">
                            <div className="min-w-0">
                              {showName && <p className="truncate text-base font-bold text-foreground">{row.agentName}</p>}
                              {subtitle && <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {showBrand && (
                                <span className="rounded-full border-[0.5px] border-border px-2.5 py-0.5 text-[11px] text-muted-foreground">
                                  {row.brand}
                                </span>
                              )}
                              {showStatus && (
                                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${walletStatusBadgeClasses(row.walletStatus)}`}>
                                  {row.walletStatus}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {showBalance && (
                          <div className={`flex items-center justify-between ${hasHeader ? 'pt-3' : ''}`}>
                            <span className="text-[12px] text-muted-foreground">Company Balance</span>
                            <span className={`text-xl font-bold tabular-nums ${row.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{displayNum(row.runningBalance)}</span>
                          </div>
                        )}

                        {gridFields.length > 0 && (
                          <div className={`grid grid-cols-3 gap-x-3 gap-y-3 ${(hasHeader || showBalance) ? 'mt-3' : ''}`}>
                            {gridFields.map((key) => {
                              const col = columnDefs.find((c) => c.key === key)!;
                              const { value, className } = mobileCardFieldValue(row, key);
                              return (
                                <div key={key}>
                                  <p className="text-[11px] text-muted-foreground">{col.label}</p>
                                  <p className={`mt-0.5 text-[13px] font-semibold tabular-nums ${className}`}>{value}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    title="No matching accounts found"
                    description="Try adjusting your search or filters."
                    action={
                      <button type="button" onClick={clearAllFilters} className={GHOST_BUTTON}>
                        Clear Filters
                      </button>
                    }
                  />
                )}
              </div>
            </div>

            {!loading && (
              <TableFooter
                recordCountText={
                  sortedRows.length === 0
                    ? 'Showing 0 of 0 Accounts'
                    : `Showing ${startIndex + 1}–${Math.min(endIndex, sortedRows.length)} of ${sortedRows.length} Accounts`
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