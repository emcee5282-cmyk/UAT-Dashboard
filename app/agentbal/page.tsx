'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, Columns3, Download, Search, Upload, Wallet,
  Shield, ArrowUpDown,
  Tag, User, FilterX,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Manrope, Space_Grotesk } from 'next/font/google';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import DataTable from '../components/DataTable';
import CompactTableFooter from '../components/CompactTableFooter';
import EmptyState from '../components/EmptyState';
import TableLoadingSpinner from '../components/TableLoadingSpinner';
import FilterDropdown from '../components/FilterDropdown';
import ColumnsDropdown from '../components/ColumnsDropdown';
import BalanceLimitUploadModal from '../components/BalanceLimitUploadModal';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { rawVal, fmt, fmtAbbrev, exportNum } from '@/app/lib/format';
import { parseCsvLines } from '../lib/csv';
import { normalizeOpeningAgentName, extractOpeningWalletTypeSuffix } from '../lib/realShopName';
import { getBusinessToday, toBusinessDate, parseCardCutoffDate } from '../lib/businessDate';
import {
  computeWalletStatus,
  WALLET_STATUS_OPTIONS,
  computeCompanyBalance,
  computeAgentWithdrawal,
  computeSdpVsBalance,
  resolveBrand,
} from '../lib/balanceEngine';
import { getPreference, setPreference } from '../lib/preferences';
import type { BalanceLimitWalletRow } from '../lib/db/read/balanceLimit';
import type { AgentBalanceSplitRow as PgAgentBalanceRow } from '@/app/lib/services/balanceService';

// Page-scoped font override (Manrope for body/labels, Space Grotesk for
// tabular-nums), matching Daily Txn Entry's own treatment and Top Up's port
// of it (app/topup/page.tsx) — per explicit instruction, Balance now
// matches Top Up's typeface exactly, not just its font SIZE. Every other
// page keeps Inter.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

type OpeningRow = {
  agentName: string;
  openingBal: string;
  sdp: string;
  leader: string;
};

type MergedRow = OpeningRow & {
  // Real agents.agent_code — distinct from `agentName` (the display label)
  // only for a per-wallet split row on the Postgres path, where agentName
  // is instead the Opening file's own raw per-wallet text (e.g.
  // "N-K1AG-T1-SANGE006-BK"). Anything that needs to match against the real
  // roster (e.g. the Balance Limit upload wizard's own agentRoster prop)
  // must use this field, not agentName.
  agentCode: string;
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

// A shop auto-created by the Balance Limit upload (unmatched shop code with
// real DP/WD activity — see balanceLimitService.ts) has no real SDP to show
// (the column is numeric, so it can't literally store "NEW SHOP" — leader
// is the one field that actually carries that text, via a real "NEW SHOP"
// leader record). Displaying the raw 0 here would misleadingly read as "a
// real shop with zero SDP" instead of "no SDP data exists yet" — this
// keys off the same signal every other page would use to spot one of these
// rows: its Leader is literally "NEW SHOP".
function sdpDisplay(row: MergedRow): string {
  return row.leader === 'NEW SHOP' ? 'NEW SHOP' : displayNum(row.sdp);
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

const WALLET_TYPE_ORDER = [
  { match: 'BKASH', abbreviation: 'BK' },
  { match: 'NAGAD', abbreviation: 'NG' },
  { match: 'ROCKET', abbreviation: 'RK' },
  { match: 'UPAY', abbreviation: 'UP' },
];
const WALLET_TYPE_ABBREVIATIONS: Record<string, string> = Object.fromEntries(
  WALLET_TYPE_ORDER.map(({ match, abbreviation }) => [match, abbreviation])
);

function computeWalletType(types: string[]): string {
  const normalized = new Set(types.map((raw) => raw.trim().toUpperCase()).filter((t) => t && t !== '-'));

  const abbreviations = WALLET_TYPE_ORDER
    .filter(({ match }) => normalized.has(match))
    .map(({ abbreviation }) => abbreviation);

  return abbreviations.length > 0 ? abbreviations.join(', ') : '−';
}

// Same pattern as Send Money Balance's own flag (app/sendmoney/balances/
// page.tsx) — page-scoped, explicit opt-in only. Any value other than the
// literal 'postgres' keeps this page on Google Sheets, its always-safe
// default. Only /api/v2/balance-limit and /api/v2/stlmtopup are already
// unconditionally Postgres-backed above (both paths use them); this flag
// gates the one remaining Sheets call, /api/opening, plus the roster/
// Opening/SDP/Company Balance figures that come from it.
function isPostgresSourceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AGENTBAL_SOURCE === 'postgres';
}

const WALLET_TYPE_FILTER_OPTIONS = [
  { label: 'Bkash', abbreviation: 'BK' },
  { label: 'Nagad', abbreviation: 'NG' },
  { label: 'Rocket', abbreviation: 'RK' },
  { label: 'UPay', abbreviation: 'UP' },
];

const WALLET_TYPE_FILTER_LABELS = [...WALLET_TYPE_FILTER_OPTIONS.map((opt) => opt.label), '-'];

const EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE',
  'MUNIM', 'NIHJUM', 'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN',
  'ROSE', 'SAM', 'XYZ', 'SHAKIL', 'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR'
];

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

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
// (text-[12.5px] font-normal Manrope), the header label (text-[11.5px]
// font-bold Manrope, uppercase — measured via the UPPERCASED label string
// below since uppercase glyphs are wider than mixed-case ones) and
// WalletStatusBadge (text-[11px] font-medium Manrope). Brand is plain text
// now (no badge — matches Top Up), so it shares BODY_TEXT_FONT, no
// dedicated font constant of its own. Kept in sync with the real CSS
// classes below so the canvas measurement stays accurate to what's
// actually rendered, per explicit instruction to match Top Up's own
// typeface (Manrope/Space Grotesk), not just its font size.
const BODY_TEXT_FONT = '400 12.5px Manrope, sans-serif';
const HEADER_TEXT_FONT = '700 11.5px Manrope, sans-serif';
const WALLET_STATUS_BADGE_FONT = '500 11px Manrope, sans-serif';

// px-[12px] cell padding = 12px each side = 24px total, on every cell —
// widened from the earlier 8px per explicit instruction to "maximize the
// spacing" between columns, matching Daily Txn Entry's own brand-grid table
// (app/daily-txn-entry/page.tsx's LedgerCard, px-3/px-3.5). Except
// right-aligned columns, which use asymmetric pl-[12px] pr-[29px] (41px
// total) instead: right-aligned sortable headers position their label
// flush against the padding-right edge (justify-end) and then hang the
// sort icon off the label's own right edge via absolute positioning, so
// the icon extends INTO the padding-right zone rather than being reserved
// for by the column's overall width — a plain 12px right pad isn't enough
// room for it and the icon gets clipped by the header cell's
// overflow-hidden. Same asymmetric convention already established for
// Transfer Queue's numeric columns (app/transfer-queue/page.tsx), just
// widened by the same +4px as the baseline padding.
const CELL_PADDING_PX = 24;
const CELL_PADDING_RIGHT_ALIGN_PX = 41;
// Sort icon + its gap reserve, for sortable headers only (see SortIcon).
const HEADER_SORT_ICON_RESERVE_PX = 19;
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
    case 'sdp': return sdpDisplay(row);
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
    const font = col.key === 'walletStatus' ? WALLET_STATUS_BADGE_FONT : BODY_TEXT_FONT;
    const chrome = col.key === 'walletStatus' ? WALLET_STATUS_BADGE_CHROME_PX : 0;
    const cellPadding = col.align === 'right' ? CELL_PADDING_RIGHT_ALIGN_PX : CELL_PADDING_PX;

    let maxTextWidth = 0;
    for (const row of rows) {
      const w = measureTextWidthPx(getColumnDisplayText(row, col.key) ?? '', font);
      if (w > maxTextWidth) maxTextWidth = w;
    }
    const dataWidth = maxTextWidth > 0 ? Math.ceil(maxTextWidth) + chrome + cellPadding + EXTRA_BREATHING_ROOM_PX : 0;

    // Right-aligned sortable headers don't need this reserve added on top —
    // their sort icon lives inside the wider pr-[25px] (already folded into
    // cellPadding above), not in normal flow after the label like left-
    // aligned headers' inline gap-1.5 icon does. Measured in UPPERCASE
    // (matching the header's own `uppercase` CSS transform — Top Up's
    // typography, per explicit instruction) since capital glyphs are wider
    // than the label's own mixed-case string.
    const headerWidth = Math.ceil(measureTextWidthPx(col.label.toUpperCase(), HEADER_TEXT_FONT))
      + cellPadding
      + (col.sortable && col.align !== 'right' ? HEADER_SORT_ICON_RESERVE_PX : 0);

    const width = Math.max(dataWidth, headerWidth);
    if (width > 0) result[col.key] = width;
  }

  // Wallet Status is sized to fit its own longest real value ("Wallet With
  // Issue") but that leaves ~26px of dead space against every shorter
  // badge shown in practice ("Top Up Acc.", "Disconnected", etc.) — made
  // more noticeable by the table's own right-edge fade cue sitting right
  // on top of it. Brand, at the opposite end, is tight around its 2-3
  // char code. Verified against the full live dataset (Playwright,
  // scrollWidth vs clientWidth across all 3,787 rows/8 pages): Wallet
  // Status's real content tops out at 113px against a 139px column, so
  // shifting 20px to Brand still leaves a comfortable margin.
  if (result.walletStatus !== undefined && result.brand !== undefined) {
    result.walletStatus -= 20;
    result.brand += 20;
  }
  return result;
}

const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#E2E8F0] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Responsive action buttons (Refresh/Export/Columns) — icon+text when the
// viewport has room, collapsing to icon-only (40x40, no padding) once space
// gets tight, per explicit instruction. `xl:` is the "has room" breakpoint;
// the label is `hidden` below it, `title` supplies a tooltip either way so
// the icon-only state stays identifiable on hover.
// Compact sizing (matches Wallet Status/Transfer Queue/Top Up/Settlement/
// Opening's own density): h-10/rounded-[12px]/text-[13px] scaled down to
// h-8/rounded-[10px]/text-[11px], gap-1.5 -> gap-[5px] — was left over at
// the old full size while those other pages had already migrated, per
// explicit instruction.
const ICON_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label, unlike ICON_BUTTON's
// xl: breakpoint reveal) — Columns only, per explicit instruction to match
// Settlement/Top Up's own Columns button. Refresh/Export keep ICON_BUTTON.
const ICON_ONLY_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

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
      size={11}
      className={active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}
    />
  );
}

function headerCellClasses(colKey: ColumnKey, _isSorted: boolean) {
  // Right-aligned columns get asymmetric pl-[12px] pr-[29px] — their sort
  // icon hangs off the right-justified label via absolute positioning
  // (see the sort button JSX below), extending into the padding-right
  // zone rather than being reserved for by the column's own width, so a
  // plain px-[12px] isn't enough room and the icon gets clipped by this
  // header's own overflow-hidden. Same convention as Transfer Queue,
  // widened +4px per explicit "maximize the spacing" instruction, matching
  // Daily Txn Entry's own brand-grid table column spacing.
  const paddingCls = COLUMN_ALIGN[colKey] === 'right' ? 'pl-[12px] pr-[29px]' : 'px-[12px]';
  // Size/weight/case matched to Top Up's own table header cells
  // (app/topup/page.tsx: text-[11.5px] font-bold uppercase tracking-[0.03em])
  // per explicit instruction.
  return `group overflow-hidden whitespace-nowrap ${paddingCls} text-${COLUMN_ALIGN[colKey]} text-[11.5px] font-bold uppercase tracking-[0.03em] text-[#475569] dark:text-[#9CA3AF]`;
}

// Shared hover/focus-driven tooltip state — portal-rendered (see Tooltip
// below) so it's never clipped by the toolbar's overflow-x-auto (per the
// CSS overflow spec, a non-visible x-axis forces the y-axis to clip too).
// Takes the trigger's OWN ref rather than creating one, so callers that
// already need that ref for something else (FilterDropdown/ColumnsDropdown
// anchoring) can share a single ref instead of juggling two.
function useTooltip(triggerRef: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
      setRendered(true);
    } else {
      const timeout = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return {
    open,
    rendered,
    pos,
    handlers: {
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
      onFocus: () => setOpen(true),
      onBlur: () => setOpen(false),
    },
  };
}

// Dark, arrow-tipped, fade-in tooltip — same visual language everywhere it's
// used (all 4 filter triggers + Refresh/Export/Columns/Reset), replacing
// each button's native `title` attribute (which can't be styled and looks
// inconsistent across browsers).
//
// `onlyWhenCompact` — the 4 filters + Refresh/Export/Columns already show
// their own label as text once the toolbar has room (the `xl:` breakpoint);
// a tooltip repeating that same word right underneath is redundant there,
// so those callers pass true to force-hide it via `xl:hidden` once the
// label is visible, showing it again only when the button falls back to
// icon-only below `xl`. Reset never has a label (always icon-only), so it
// omits this and keeps its tooltip visible at every width.
function Tooltip({
  label,
  open,
  pos,
  onlyWhenCompact = false,
}: {
  label: string;
  open: boolean;
  pos: { top: number; left: number };
  onlyWhenCompact?: boolean;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)' }}
      className={`pointer-events-none z-[9999] whitespace-nowrap rounded-md bg-[#1F2937] px-2.5 py-1.5 text-[12px] text-white transition-opacity duration-150 ease-out ${
        open ? 'opacity-100' : 'opacity-0'
      } ${onlyWhenCompact ? 'xl:hidden' : ''}`}
    >
      {label}
      <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#1F2937]" />
    </div>,
    document.body
  );
}

// Toolbar filter trigger — Brand/Leader/Wallet Type/Wallet Status. This is
// the trigger button only; the panel beneath it is the shared, cross-page
// FilterDropdown component (app/components/FilterDropdown.tsx). Keeping the
// trigger page-local (rather than folding it into the shared component)
// lets other pages migrate to FilterDropdown later without being forced
// into this exact shape — the shared piece is the premium multi-select
// panel itself, not the button that opens it. Base style is always neutral
// (light border, white bg) per the compact-toolbar redesign spec — active
// state is communicated by the small count badge only, not a whole-button
// color tint, so the row stays visually calm even with filters applied.
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
  const tooltip = useTooltip(buttonRef);
  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={onClick}
        aria-label={label}
        {...tooltip.handlers}
        className="inline-flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5"
      >
        <Icon size={12} className="text-[#475569] dark:text-[#9CA3AF]" />
        <span className="hidden xl:inline">{label}</span>
        {anyUnchecked && (
          <span className="flex h-[13px] min-w-[13px] animate-[dt-badge-pop_150ms_var(--ease-out-strong)] items-center justify-center rounded-full bg-indigo-600 px-[3px] text-[9px] font-semibold text-white">
            {selectedCount}
          </span>
        )}
        <ChevronDown
          size={11}
          className={`hidden text-[#475569] transition-transform duration-150 ease-[var(--ease-in-out-strong)] dark:text-[#9CA3AF] xl:inline ${menuOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {tooltip.rendered && <Tooltip label={label} open={tooltip.open} pos={tooltip.pos} onlyWhenCompact />}
    </div>
  );
}

// "Reset All Filters" trigger — uses the same shared useTooltip/Tooltip as
// every other toolbar button now.
function ResetFiltersButton({ anyFilterActive, onClick }: { anyFilterActive: boolean; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip(buttonRef);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (anyFilterActive) onClick(); }}
        {...tooltip.handlers}
        aria-label="Reset all filters"
        aria-disabled={!anyFilterActive}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out-strong)] ${
          anyFilterActive
            ? 'cursor-pointer border-[#E2E8F0] bg-white text-indigo-600 hover:border-[#FCA5A5] hover:bg-[#FEF2F2] hover:text-[#DC2626] active:scale-[0.97] active:border-[#FCA5A5] active:bg-[#FEF2F2] active:text-[#DC2626] dark:border-[#262B38] dark:bg-[#12151D] dark:text-indigo-400'
            : 'cursor-default border-[#E2E8F0] bg-white text-[#475569] opacity-40 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF]'
        }`}
      >
        {/* Filled (not just outlined) once a filter is actually active — the
            icon's fill tracks currentColor, so it goes indigo at rest and
            red on hover/active along with the text color above. Stays
            fill="none" (plain Lucide outline) while disabled. */}
        <FilterX size={16} fill={anyFilterActive ? 'currentColor' : 'none'} />
      </button>
      {tooltip.rendered && <Tooltip label="Reset all filters" open={tooltip.open} pos={tooltip.pos} />}
    </div>
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
    // Explicit hex per instruction (#F59E0B / Amber 500) — kept as its own
    // literal value rather than Tailwind's amber-50/700 pairing (already
    // used above for WD Only) so the two read as visibly different colors,
    // not just different labels on the same color.
    case 'Disable':
      return 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30 dark:bg-[#F59E0B]/15 dark:border-[#F59E0B]/40';
    // Daily/Monthly Reach Limit — Send Money-only in practice (see
    // balanceEngine.ts's computeSendMoneyWalletStatus), kept here too for
    // visual consistency between both pages' badge language. Violet: a
    // real, non-muted color deliberately distinct from every other status
    // here (including Disable's amber), per explicit instruction.
    case 'Daily Reach Limit':
    case 'Monthly Reach Limit':
      return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-900/50';
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

// Brand is plain text (no badge) — matches Top Up (app/topup/page.tsx):
// Wallet Status only has a handful of values (color-coding aids scanning),
// but Brand has 10, which would be visually noisy with 10 badge colors.

// Hero KPI card — ported from Daily Txn Entry's own PgBalanceCard
// (app/daily-txn-entry/page.tsx) exactly: big value + a tinted ▲/▼ pill
// showing the net movement vs Opening. Used for Running Balance, the
// biggest figure in the row, per explicit instruction/reference screenshot.
function HeroStatCard({ label, value, openingValue, discrepancy }: { label: string; value: number; openingValue: number; discrepancy?: number }) {
  const change = value - openingValue;
  const up = change >= 0;
  return (
    <div className="kpi-value-fade-in flex flex-col rounded-lg border border-border bg-white px-3 py-2.5 dark:bg-[#12151D]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <div className="flex flex-1 flex-col justify-center gap-1">
        <p className={`text-[19px] font-semibold tabular-nums ${value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{fmtAbbrev(value)}</p>
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-[3px] text-[10.5px] tabular-nums ${
            up ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400'
          }`}
        >
          {up ? '▲' : '▼'} {fmt(Math.abs(change))} vs Opening
        </span>
        {/* Agent Withdrawal total — a second, smaller/plainer line under the
            "vs Opening" badge (not another colored pill, per explicit "don't
            make it too big" instruction), left-aligned in the same bottom
            area, additive to the existing badge rather than replacing it. */}
        {discrepancy !== undefined && (
          <p className="mt-1 text-[10px] font-[440] tabular-nums text-muted-foreground">
            Discrepancy: {fmt(discrepancy)}
          </p>
        )}
      </div>
    </div>
  );
}

// Grid KPI card — ported from Daily Txn Entry's own StatCard
// (app/daily-txn-entry/page.tsx) exactly. `variant="deduction"` reds
// Total WD/Settlement (stored as positive magnitudes but read as
// deductions), per explicit instruction — everything else (including
// Total DP, kept neutral/black per explicit instruction) stays neutral,
// red only if the raw value itself is negative.
function GridStatCard({ label, value, variant }: { label: string; value: number; variant?: 'deduction' }) {
  const colorClass =
    variant === 'deduction' && value !== 0 ? 'text-rose-600 dark:text-rose-400'
    : value < 0 ? 'text-rose-600 dark:text-rose-400'
    : 'text-foreground';
  return (
    <div className="kpi-value-fade-in flex flex-1 flex-col justify-between gap-0.5 rounded-lg border border-border bg-white px-3 py-2 dark:bg-[#12151D]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p className={`text-[15.5px] font-semibold tabular-nums ${colorClass}`}>{fmt(value)}</p>
    </div>
  );
}

// Mobile card grid fields — mirrors renderCell's data + colors, minus the
// columns (walletName, walletStatus, companyBalance) shown in the card header/hero.
function mobileCardFieldValue(row: MergedRow, key: ColumnKey): { value: string; className: string } {
  switch (key) {
    case 'brand':
      return { value: row.brand, className: 'text-foreground' };
    case 'leader':
      return { value: toProperCase(row.leader), className: 'text-muted-foreground' };
    case 'walletType':
      return { value: row.walletType, className: 'text-muted-foreground' };
    case 'sdp':
      return { value: sdpDisplay(row), className: 'text-foreground' };
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
      return { value: formatted, className: 'text-foreground' };
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
  // Total WD/Settlement are the explicit exception: green for inflow (DP),
  // red + a leading "-" for outflows (WD, Settlement — stored as positive
  // magnitudes but read as deductions), neutral whenever the value is
  // zero/blank (the em-dash). Top Up is neutral (no color), matching the
  // Amount column's own plain styling on the actual Top Up tab
  // (app/topup/page.tsx) — same convention applied to Send Money's own
  // Balance page (app/sendmoney/balances/page.tsx). Company Balance stays
  // fully neutral, no exception.
  // Right-aligned data must match the header's own asymmetric pl-[12px]
  // pr-[29px] inset (see headerCellClasses), not the cell's true right
  // edge, or the numbers drift out of alignment with their header label.
  // Widened +4px per explicit "maximize the spacing" instruction, matching
  // Daily Txn Entry's own brand-grid table column spacing.
  const dataPaddingCls = COLUMN_ALIGN[key] === 'right' ? 'pl-[12px] pr-[29px]' : 'px-[12px]';
  // Size AND row density matched to Top Up's own table body cells
  // (app/topup/page.tsx: text-[12.5px], py-1.5 = 6px) per explicit
  // instruction — color kept as this page's own established token (font
  // style/size only, not color).
  const baseNoColor = `whitespace-nowrap ${dataPaddingCls} py-[6px] text-${COLUMN_ALIGN[key]} text-[12.5px] leading-[16px] font-normal`;
  const base = `${baseNoColor} text-[#111827] dark:text-[#E5E7EB]`;
  // Every column gets the same fixed width treatment (see
  // computeColumnWidthsPx above) — not just Shop Name.
  const width = colWidthsPx?.[key];
  const cellStyle = width ? { width, minWidth: width } : undefined;

  switch (key) {
    case 'brand':
      return <td key={key} style={cellStyle} title={row.brand} className={base}>{row.brand}</td>;
    case 'leader':
      return <td key={key} style={cellStyle} className={base}>{toProperCase(row.leader)}</td>;
    case 'walletName':
      return <td key={key} style={cellStyle} className={base}>{row.agentName}</td>;
    case 'walletType':
      return <td key={key} style={cellStyle} className={base}>{row.walletType}</td>;
    case 'sdp':
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{sdpDisplay(row)}</td>;
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
      return <td key={key} style={cellStyle} className={`${base} tabular-nums`}>{formatted}</td>;
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
  // Bulk Import Balance Limit's own last-upload timestamp — THIS page's own
  // data source (agent_wallets/Company Balance etc all come from this
  // upload), shown in the header's switcher row. Previously this page also
  // showed Opening's own last-upload timestamp there — removed per explicit
  // correction: each page must show only its OWN source's timestamp, never
  // a borrowed one from a different upload (Opening's own timestamp stays
  // on Opening's own page, unaffected). See fetchData's Sheets-path branch
  // below for the other source; Postgres-path (isPostgresSourceEnabled)
  // fetches it via /api/v2/agentbal's own lastImport field.
  const [lastBalanceLimitUpload, setLastBalanceLimitUpload] = useState<Date | null>(null);
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
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const exportTooltip = useTooltip(exportButtonRef);
  const columnsTooltip = useTooltip(columnsButtonRef);
  const uploadTooltip = useTooltip(uploadButtonRef);
  // Phase 8b — Balance Limit upload wizard's own open/close state. Sourced
  // from app/agentbal/page.tsx's already-loaded `rows` (agentName IS the
  // resolved shop code, same roster agents.agent_code was seeded from), so
  // the modal's client-side preview can flag an unmatched shop before the
  // real upload without a second fetch.
  const [balanceLimitModalOpen, setBalanceLimitModalOpen] = useState(false);

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
  const [isHScrolled, setIsHScrolled] = useState(false);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      setIsScrolled(el.scrollTop > 0);
      setIsHScrolled(el.scrollLeft > 0);
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

  // Toolbar's own "Reset All Filters" button — filters only, deliberately
  // leaves searchTerm untouched (unlike clearAllFilters above, used by the
  // empty-state's "Clear Filters" action where clearing search too makes
  // sense). Also closes any open filter dropdown, per spec.
  const resetAllFilters = useCallback(() => {
    setBrandFilter({});
    setLeaderFilter({});
    setWalletTypeFilter({});
    setWalletStatusFilter(Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, true])));
    setBrandMenuOpen(false);
    setLeaderMenuOpen(false);
    setWalletTypeMenuOpen(false);
    setWalletStatusMenuOpen(false);
  }, []);

  const fetchData = useCallback(async () => {
    scrollRef.current = window.scrollY;
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      if (isPostgresSourceEnabled()) {
        // Postgres path — /api/v2/agentbal already computes every financial
        // field server-side (balanceService.ts, the same balanceEngine.ts
        // formulas the Sheets path below calls directly), including
        // walletStatus and walletType (raw type codes; this page's own
        // computeWalletType() still does the abbreviate-and-join formatting,
        // so that logic isn't duplicated a third time). No separate Balance
        // Limit ROWS fetch is needed here — unlike the Sheets path below,
        // which still reads them client-side for Wallet Type/Status, the
        // Postgres route already folds that in. It does still return
        // lastImport (Bulk Import Balance Limit's own last-upload
        // timestamp) alongside rows, for the header's "Updated" indicator.
        const res = await fetch(`/api/v2/agentbal?t=${Date.now()}`);
        await assertAllOk([res]);
        const { rows: pgRows, lastImport }: { rows: PgAgentBalanceRow[]; lastImport: { fileName: string; uploadedBy: string; completedAt: string } | null } = await res.json();
        setLastBalanceLimitUpload(lastImport?.completedAt ? new Date(lastImport.completedAt) : null);
        const merged: MergedRow[] = pgRows.map((row) => ({
          agentCode: row.agentCode,
          agentName: row.displayName,
          openingBal: String(row.openingBalance),
          sdp: String(row.sdp),
          leader: row.leader,
          agentTotalDP: row.totalDp,
          agentTotalWD: row.totalWd,
          totalTopUp: row.totalTopUp,
          totalStlm: row.totalSettlement,
          balanceInside: row.balanceInside,
          runningBalance: row.companyBalance,
          agentWithdrawal: row.agentWithdrawal,
          sdpVsBalance: row.sdpVsBalance,
          walletStatus: row.walletStatus,
          brand: row.brand,
          walletType: computeWalletType(row.walletType),
        }));

        setRows(merged);
        setTimeout(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.scrollTo({ top: scrollRef.current, behavior: 'instant' });
            });
          });
        }, 50);
        return;
      }

      const [openingRes, balRes, stlmRes, estimatedRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        // Phase 8B — Balance Limit's own display now reads PostgreSQL
        // (written by the validated Phase 8/8A upload pipeline), not
        // Google Sheets. Opening/Estimated Opening below are unrelated to
        // Balance Limit and stay on Sheets, unchanged.
        fetch(`/api/v2/balance-limit?product=cashout&t=${Date.now()}`),
        // Settlement/Top Up migration — reads PostgreSQL (wallet_transactions,
        // via the Settlement/Top Up bulk-import wizards) instead of the raw
        // "AG BD STLM + TOPUP" sheet. Server-side already applies the same
        // topUpSettlementCutoff widening this file computes below for the
        // Assumed Balance check, so no client-side date filtering is needed
        // here anymore — see app/lib/services/balanceService.ts's
        // getTopUpSettlementTotals().
        fetch(`/api/v2/stlmtopup?product=cashout&t=${Date.now()}`),
        fetch(`/api/opening/estimated-balance?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, estimatedRes]);

      const openingText = await openingRes.text();
      const balJson: { rows: BalanceLimitWalletRow[]; lastImport: { fileName: string; uploadedBy: string; completedAt: string } | null } = await balRes.json();
      const stlmJson: { totals: Record<string, { totalTopUp: number; totalSettlement: number }> } = await stlmRes.json();
      const estimatedData: { balances: Record<string, number>; uploadedAt: string | null } = await estimatedRes.json();

      // Balance's own "Updated" indicator (header, top-right) — reflects
      // when the Bulk Import Balance Limit file was last uploaded, not page
      // load time, per explicit instruction. /api/v2/balance-limit already
      // returns this (getBalanceLimitLastImport, Phase 8B) — it just had no
      // UI slot until now.
      setLastBalanceLimitUpload(balJson.lastImport?.completedAt ? new Date(balJson.lastImport.completedAt) : null);

      const openingRawRows = parseCsvLines(openingText);
      // Opening's own "Updated Time" card — still needed to detect whether
      // Opening AG has been manually refreshed yet, for the Assumed Balance
      // validity check below AND (per explicit instruction) the Top Up/
      // Settlement cutoff further down, so Company Balance and the
      // Dashboard's own Top Up/Settlement (app/page.tsx) never disagree —
      // same figures whether the user reads them here or exports this page.
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);

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
      // Per explicit instruction, kept as this original dual-condition check
      // for Cashout — Send Money's own counterpart
      // (app/sendmoney/balances/page.tsx) dropped requirement 1.
      const estimatedUploadedAt = estimatedData.uploadedAt ? new Date(estimatedData.uploadedAt) : null;
      const estimatedOpeningValid =
        reportCutoffDate !== null &&
        reportCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedUploadedAt !== null &&
        toBusinessDate(estimatedUploadedAt).getTime() === getBusinessToday().getTime();
      const estimatedBalances = new Map(Object.entries(estimatedData.balances ?? {}));

      // Top Up/Settlement's own date-window widening (matching this exact
      // rule) now happens server-side in getTopUpSettlementTotals() — see
      // the /api/v2/stlmtopup fetch above. No client-side cutoff needed here
      // anymore.

      const openingRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          // Kept RAW here — display, the row's React key, and row-selection
          // identity all key off this field, and ~1,446 real Opening AG
          // rows are genuinely per-WALLET entries (e.g.
          // "N-M1AG-R5-SHAKER068-BK" / "...-NG", each its own real Balance/
          // Opening/DP/WD — confirmed live, NOT duplicates of one shop) that
          // must stay visually distinguishable as separate rows. Matching
          // against Postgres data (which is always bare-coded) instead
          // happens per-lookup, below, via normalizeOpeningAgentName() /
          // extractOpeningWalletTypeSuffix() — see the merge step's own
          // comment for which lookups need the wallet-type suffix (DP/WD,
          // Wallet Type, Wallet Status) vs. which stay bare-shop-code only
          // (Top Up/Settlement, Balance Inside, Brand).
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

      // Already clean, typed JSON objects (one row per agent/wallet-type,
      // same shape the sheet-based parsing above used to build by hand) —
      // no CSV header row to skip, no blank-row filtering needed.
      const balRows = balJson.rows.filter((row) => row.agentCode && row.agentCode !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.agentCode));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      // Per-WALLET DP/WD, e.g. "SHAKER068-BK". Top Up/Settlement, Brand, and
      // Balance Inside genuinely ARE shop-level (Postgres doesn't track a
      // per-wallet version of those) and correctly stay aggregated across
      // however many wallets the shop has, matched via bareCode in the
      // merge step below. Wallet Type and Wallet Status are NOT shop-level
      // — despite being (wrongly) grouped in with the shop-level ones
      // originally — each is a real per-wallet attribute (one Postgres
      // agent_wallets row = one wallet's own Type/Status), confirmed live
      // via MAYA001 (4 real wallets: BK/NG/RK/UP) whose "-UP" Opening row
      // was showing "BK, RK, UP" / "DP + WD" instead of just UP's own
      // "UP" / "WD Only". Those two get their own per-wallet maps below
      // (walletTypeValuesByWallet / walletStatusValuesByWallet), same
      // pattern as this one.
      const balanceTotalsByWallet = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      const walletStatusValues = new Map<string, string[]>();
      const brandGroups = new Map<string, string[]>();
      const walletTypeValues = new Map<string, string[]>();
      // Per-WALLET Type and Status — same reasoning as balanceTotalsByWallet
      // above: a Pattern B row (e.g. "N-M1AG-A4-MAYA001-UP") represents only
      // ONE of a shop's several real wallets, so it must read only that
      // wallet's own Type/Status, not every wallet's rolled up together.
      // Confirmed live: MAYA001 has 4 real wallets (BK/NG/RK/UP), its -UP
      // row was showing "BK, RK, UP" for Type (every logged-in wallet) and
      // "DP + WD" for Status (dominance across all 3) instead of just UP's
      // own "UP" / "WD Only" — this was the bug the shop-level maps below
      // (walletTypeValues/walletStatusValues) still have for Pattern A rows
      // (a shop's ONE combined row, where "every wallet" is correct).
      const walletTypeValuesByWallet = new Map<string, string[]>();
      const walletStatusValuesByWallet = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const name = bal.agentCode;
        // A wallet that's Disconnected (Login=No) or Disable no longer
        // contributes its DP/WD to the shop's Total DP/WD — per explicit
        // instruction, its own historical figures are stale/frozen and
        // must not inflate the live-looking total. Confirmed live:
        // FADE050's BKASH wallet is Disable with a stale 5,000 DP while
        // its other 3 wallets are healthy DP+WD — the row's Wallet Status
        // badge correctly shows "DP + WD" (dominance ranking across
        // wallets is unchanged/correct), but Total DP was silently
        // including that disabled wallet's 5,000 on top. Company Balance
        // (opening + totalDP + topUp − totalWD − settlement) benefits
        // automatically since it's derived from these totals.
        const excludedFromDpWd = !bal.isLoggedIn || bal.accountStatus === 'Disable';
        if (!excludedFromDpWd) {
          const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
          balanceTotals.set(name, {
            dp: existing.dp + bal.totalDP,
            wd: existing.wd + bal.totalWD,
          });
        }

        const walletSuffix = WALLET_TYPE_ABBREVIATIONS[bal.walletType];
        if (walletSuffix && !excludedFromDpWd) {
          const walletKey = `${name}-${walletSuffix}`;
          const existingWallet = balanceTotalsByWallet.get(walletKey) ?? { dp: 0, wd: 0 };
          balanceTotalsByWallet.set(walletKey, {
            dp: existingWallet.dp + bal.totalDP,
            wd: existingWallet.wd + bal.totalWD,
          });
        }

        if (bal.group && bal.group !== '-') {
          const groups = brandGroups.get(name) ?? [];
          groups.push(bal.group);
          brandGroups.set(name, groups);
        }

        if (bal.accountStatus && bal.accountStatus !== '-') {
          const statuses = walletStatusValues.get(name) ?? [];
          // A wallet that isn't logged in reads as Disconnected regardless
          // of what its Group would otherwise resolve to.
          statuses.push(bal.isLoggedIn ? bal.accountStatus : 'Disconnected');
          walletStatusValues.set(name, statuses);

          if (walletSuffix) {
            const walletKey = `${name}-${walletSuffix}`;
            const statusesForWallet = walletStatusValuesByWallet.get(walletKey) ?? [];
            statusesForWallet.push(bal.isLoggedIn ? bal.accountStatus : 'Disconnected');
            walletStatusValuesByWallet.set(walletKey, statusesForWallet);
          }
        }

        if (bal.walletType && bal.walletType !== '-' && bal.isLoggedIn) {
          const types = walletTypeValues.get(name) ?? [];
          types.push(bal.walletType);
          walletTypeValues.set(name, types);

          if (walletSuffix) {
            const walletKey = `${name}-${walletSuffix}`;
            const typesForWallet = walletTypeValuesByWallet.get(walletKey) ?? [];
            typesForWallet.push(bal.walletType);
            walletTypeValuesByWallet.set(walletKey, typesForWallet);
          }
        }

        if (bal.isLoggedIn) {
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + bal.balance);
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
      // Top Up/Settlement keys are normalized (uppercased, all whitespace
      // stripped) before every set/get on this map — /api/v2/stlmtopup keys
      // by agents.agent_code exactly, but the Opening roster's own agentName
      // text isn't always cased/spaced the same (e.g. "Konan001 " vs
      // "KONAN001"), which previously (Sheets-sourced) silently dropped that
      // agent's Top Up/Settlement from its sum since the Map key never
      // matched. Scoped to just this lookup — opening.agentName itself is
      // left untouched for every other map below, since those sheets
      // haven't shown this mismatch.
      const normalizeAgentKey = (name: string): string => name.toUpperCase().replace(/\s+/g, '');

      const stlmTopUpTotals = new Map<string, { totalTopUp: number; totalSettlement: number }>();
      for (const [agentCode, totals] of Object.entries(stlmJson.totals ?? {})) {
        stlmTopUpTotals.set(normalizeAgentKey(agentCode), totals);
      }

      const merged: MergedRow[] = openingRows.map((opening) => {
        // bareCode is the identity every Postgres-sourced map below is
        // keyed by (agents.agent_code, always bare). walletSuffix is only
        // non-null for a Pattern B row (opening.agentName carries a real
        // wallet-account string, not a bare code) — see
        // extractOpeningWalletTypeSuffix's own comment.
        const bareCode = normalizeOpeningAgentName(opening.agentName);
        const walletSuffix = extractOpeningWalletTypeSuffix(opening.agentName);
        // DP/WD is the one figure that's genuinely per-wallet — a Pattern B
        // row must read ONLY its own wallet's totals (balanceTotalsByWallet),
        // never the shop's combined total (balanceTotals), or two of a
        // shop's separate wallet rows would both show the same summed
        // figure instead of their own real, different ones (confirmed live:
        // SHAKER068-BK is 94,850/30,833, SHAKER068-NG is 39,320/41,300 —
        // showing 134,170/72,133 on both was the bug this replaces).
        const totals = walletSuffix
          ? (balanceTotalsByWallet.get(`${bareCode}-${walletSuffix}`) ?? { dp: 0, wd: 0 })
          : (balanceTotals.get(bareCode) ?? { dp: 0, wd: 0 });
        // Top Up/Settlement and Balance Inside stay shop-level (bareCode
        // only, never walletSuffix) — Postgres doesn't track "this wallet's
        // own Top Up" as a distinct concept, so a shop's several Pattern B
        // rows correctly show the SAME (correct) value for both, same as
        // they always have for a normal multi-wallet shop's one row. Wallet
        // Type and Wallet Status are NOT shop-level though — each is a real
        // per-wallet attribute in Postgres (see walletTypeValuesByWallet's
        // comment above) — a Pattern B row must read only its own wallet's
        // Type/Status, same as DP/WD already does.
        const stlmTopUp = stlmTopUpTotals.get(normalizeAgentKey(bareCode));
        const totalTopUp = stlmTopUp?.totalTopUp ?? 0;
        const totalStlm = stlmTopUp?.totalSettlement ?? 0;
        const balanceInside = balanceInsideTotals.get(bareCode) ?? 0;
        const runningBalance = computeCompanyBalance(parseNumber(opening.openingBal), totals.dp, totalTopUp, totals.wd, totalStlm);
        const sdpNum = parseNumber(opening.sdp);
        const walletStatus = balWalletNames.has(bareCode)
          ? computeWalletStatus(
              walletSuffix
                ? (walletStatusValuesByWallet.get(`${bareCode}-${walletSuffix}`) ?? [])
                : (walletStatusValues.get(bareCode) ?? [])
            )
          : 'No Record';
        return {
          ...opening,
          agentCode: bareCode,
          agentTotalDP: totals.dp,
          agentTotalWD: totals.wd,
          totalTopUp,
          totalStlm,
          balanceInside,
          runningBalance,
          agentWithdrawal: computeAgentWithdrawal(runningBalance, balanceInside),
          sdpVsBalance: computeSdpVsBalance(opening.leader, opening.sdp, sdpNum, runningBalance, EXCLUDED_SDP_LEADERS),
          walletStatus,
          // Second arg stays the RAW opening.agentName on purpose — resolveBrand's
          // own fallback (zero real Group data) matches a brand code as a
          // substring of this string, and a Pattern B row's raw account text
          // (e.g. "N-M1AG-R5-...") still carries that brand segment ("M1")
          // even though bareCode itself ("SHAKER068") no longer does.
          brand: resolveBrand(brandGroups.get(bareCode) ?? [], opening.agentName, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES }),
          walletType: computeWalletType(
            walletSuffix
              ? (walletTypeValuesByWallet.get(`${bareCode}-${walletSuffix}`) ?? [])
              : (walletTypeValues.get(bareCode) ?? [])
          ),
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

  const anyFilterActive = anyBrandUnchecked || anyLeaderUnchecked || anyWalletTypeUnchecked || anyWalletStatusUnchecked;

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
        if (row.walletType === '−') return isWalletTypeChecked('-');
        const rowAbbreviations = row.walletType.split(', ');
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
        if (row.walletType === '−') return isWalletTypeChecked('-');
        const rowAbbreviations = row.walletType.split(', ');
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
        if (row.walletType === '−') return isWalletTypeChecked('-');
        const rowAbbreviations = row.walletType.split(', ');
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
        if (row.walletType === '−') return isWalletTypeChecked('-');
        const rowAbbreviations = row.walletType.split(', ');
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
        counts.set('-', (counts.get('-') ?? 0) + 1);
        continue;
      }
      const rowAbbreviations = row.walletType.split(', ');
      for (const opt of WALLET_TYPE_FILTER_OPTIONS) {
        if (rowAbbreviations.includes(opt.abbreviation)) {
          counts.set(opt.label, (counts.get(opt.label) ?? 0) + 1);
        }
      }
    }
    return walletTypeOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [walletTypeFacetRows, walletTypeOptions]);

  // Hero + grid KPI card layout — ported from Daily Txn Entry's own
  // PgBalanceCard (hero) + StatCard (grid) components exactly
  // (app/daily-txn-entry/page.tsx), per explicit instruction/reference
  // screenshot. Running Balance is the hero (biggest figure, with a
  // tinted ▲/▼ delta pill vs Opening); Total DP, SDP, Total WD, Actual
  // Balance, Top Up, and Settlement fill the 3 stacked-pair columns
  // alongside it. Colors mirror this same table's own established
  // per-column convention (case 'totalDP'/'totalWD'/'settlement' in
  // renderCell below): Total DP green when nonzero, Total WD/Settlement
  // red (stored as positive magnitudes but read as deductions), everything
  // else neutral.
  const kpis = useMemo(() => {
    const totalDP = filteredRows.reduce((sum, row) => sum + row.agentTotalDP, 0);
    const totalWD = filteredRows.reduce((sum, row) => sum + row.agentTotalWD, 0);
    const totalSdp = filteredRows.reduce((sum, row) => sum + parseNumber(row.sdp), 0);
    const totalTopUp = filteredRows.reduce((sum, row) => sum + row.totalTopUp, 0);
    const totalSettlement = filteredRows.reduce((sum, row) => sum + row.totalStlm, 0);
    // Disconnected/No Record wallets never really "hold" a balance worth
    // counting toward the KPI, per explicit instruction — excluded here
    // even though balanceInside is already 0 for most of them in practice
    // (it's only summed from logged-in wallets), since a wallet can be
    // logged in with unrecognized/blank status text and still resolve to
    // "Disconnected" — this guards that edge case too.
    const totalBalanceInside = filteredRows
      .filter((row) => row.walletStatus !== 'Disconnected' && row.walletStatus !== 'No Record')
      .reduce((sum, row) => sum + row.balanceInside, 0);
    const totalRunningBalance = filteredRows.reduce((sum, row) => sum + row.runningBalance, 0);
    const totalOpening = filteredRows.reduce((sum, row) => sum + parseNumber(row.openingBal), 0);
    // Sum of each row's own Agent Withdrawal (Company Balance − Balance
    // Inside, already computed per row via computeAgentWithdrawal) — shown
    // as the Running Balance hero card's "discrepancy" figure, per explicit
    // instruction, alongside (not replacing) the existing "vs Opening" delta.
    const totalAgentWithdrawal = filteredRows.reduce((sum, row) => sum + row.agentWithdrawal, 0);

    return { totalDP, totalWD, totalSdp, totalTopUp, totalSettlement, totalBalanceInside, totalRunningBalance, totalOpening, totalAgentWithdrawal };
  }, [filteredRows]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      // "No Record" (zero agent_wallets rows for this shop) always sinks to
      // the bottom, regardless of which column is sorted or asc/desc — per
      // explicit instruction. Checked before any column-specific comparison
      // so it overrides every other sort key; unaffected by sortDirection on
      // purpose (flipping the active column's direction must never pull
      // No Record rows up to the top). Rows within each group (No Record vs.
      // everything else) still sort normally against each other below.
      const aNoRecord = a.walletStatus === 'No Record';
      const bNoRecord = b.walletStatus === 'No Record';
      if (aNoRecord !== bNoRecord) return aNoRecord ? 1 : -1;

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
          return exportNum(parseNumber(row.sdp));
        case 'opening':
          return exportNum(parseNumber(row.openingBal));
        case 'totalDP':
          return exportNum(row.agentTotalDP);
        case 'totalWD':
          return exportNum(row.agentTotalWD);
        case 'topUp':
          return exportNum(row.totalTopUp);
        case 'settlement':
          return exportNum(row.totalStlm);
        case 'companyBalance':
          return exportNum(row.runningBalance);
        case 'balanceInside':
          return exportNum(row.balanceInside);
        case 'agentWithdrawal':
          return exportNum(row.agentWithdrawal);
        case 'sdpVsBalance':
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : 0;
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
    <div className={`balance-page h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#0A0C11] ${manrope.variable} ${spaceGrotesk.variable}`}>
      {/* Page-scoped font override (Manrope/Space Grotesk, matching Daily
          Txn Entry's own treatment) — cascades down through SettlementHeader
          too even though that component is shared/universal, since it sets
          no font-family of its own. Every other page using SettlementHeader
          stays on Inter, unaffected. */}
      <style>{`
        .balance-page {
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .balance-page .tabular-nums {
          font-family: var(--font-space-grotesk), ui-monospace, monospace;
        }
      `}</style>
      <SettlementHeader
        icon={Wallet}
        title="Balance"
        isRefreshing={spinning}
        onRefresh={fetchData}
        titleExtra={
          lastBalanceLimitUpload && (
            <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
              Last Update: <span className="font-[500]! tabular-nums">{lastBalanceLimitUpload.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}</span>
            </span>
          )
        }
      />

      {/* px-4 md:px-[28px] + the inner mx-auto max-w-[1400px] wrapper (no
          padding of its own) copies Daily Txn Entry's own <main> classes
          and nesting order exactly (app/daily-txn-entry/page.tsx), matching
          Top Up (app/topup/page.tsx) — same container size/placement. No pt
          here — SettlementHeader's switcher row already owns that spacing
          (py-4, symmetric top/bottom around the pills) on every page that
          shows it, this one included. */}
      <main className="flex-1 flex flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col min-h-0">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            {/* Hero + grid KPI cards — ported from Daily Txn Entry's own
                PgBalanceCard (hero) + StatCard (grid) layout exactly
                (app/daily-txn-entry/page.tsx), per explicit
                instruction/reference screenshot. Running Balance is the
                hero (biggest figure); Total DP, SDP, Total WD, Actual
                Balance, Top Up, Settlement fill the 3 stacked-pair columns
                alongside it. Still living INSIDE the same bordered card as
                the toolbar/table (border-b divider), not a separate
                full-width band above <main>. */}
            <div className="shrink-0 border-b border-border p-[10px]">
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-4">
                {loading ? (
                  <>
                    <div className="rounded-lg border border-border bg-white p-2.5 dark:bg-[#12151D]">
                      <div className="kpi-skeleton-bar kpi-skeleton-label" />
                      <div className="kpi-skeleton-bar kpi-skeleton-value" />
                      <div className="kpi-skeleton-bar mt-2" style={{ height: 14, width: '50%' }} />
                    </div>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex flex-col gap-1.5">
                        <div className="flex-1 rounded-lg border border-border bg-white p-2.5 dark:bg-[#12151D]">
                          <div className="kpi-skeleton-bar kpi-skeleton-label" />
                          <div className="kpi-skeleton-bar kpi-skeleton-value" />
                        </div>
                        <div className="flex-1 rounded-lg border border-border bg-white p-2.5 dark:bg-[#12151D]">
                          <div className="kpi-skeleton-bar kpi-skeleton-label" />
                          <div className="kpi-skeleton-bar kpi-skeleton-value" />
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <HeroStatCard label="Running Balance" value={kpis.totalRunningBalance} openingValue={kpis.totalOpening} discrepancy={kpis.totalAgentWithdrawal} />
                    <div className="flex flex-col gap-1.5">
                      <GridStatCard label="Total DP" value={kpis.totalDP} />
                      <GridStatCard label="SDP" value={kpis.totalSdp} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <GridStatCard label="Total WD" value={kpis.totalWD} variant="deduction" />
                      <GridStatCard label="Actual Balance" value={kpis.totalBalanceInside} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <GridStatCard label="Top Up" value={kpis.totalTopUp} />
                      <GridStatCard label="Settlement" value={kpis.totalSettlement} variant="deduction" />
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* Toolbar merged back into the table's own card (shares its
                border/rounded corners via a bottom divider), per explicit
                instruction — not a separate detached card. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-[#E5E7EB] px-[13px] py-[10px] dark:border-[#262B38]">
              {/* Filters first (left), then Search (flex-1, fills the
                  middle), then Actions last (right) — Actions moved back to
                  the right per explicit instruction; Search keeps its
                  flex-1 grow/shrink behavior from the previous change. */}
              {loading ? (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[80px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[104px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[112px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                </div>
              ) : (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
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
                      icon={Wallet}
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
                  <ResetFiltersButton anyFilterActive={anyFilterActive} onClick={resetAllFilters} />
                </div>
              )}

              <div className="flex h-8 flex-1 min-w-[200px] items-center gap-[6px] rounded-full border border-[#E5E7EB] bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:border-[#262B38] dark:bg-[#12151D]">
                {loading ? (
                  <div className="dt-skeleton h-[10px] w-32 rounded-md" />
                ) : (
                  <>
                    <Search size={13} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
                    <input
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[11px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
                      placeholder="Search for anything"
                    />
                  </>
                )}
              </div>

              {loading ? (
                <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                </div>
              ) : (
                <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="relative">
                    <button type="button" ref={uploadButtonRef} onClick={() => setBalanceLimitModalOpen(true)} aria-label="Upload Balance Limit" {...uploadTooltip.handlers} className={ICON_BUTTON}>
                      <Upload size={13} />
                      <span className="hidden xl:inline">Upload</span>
                    </button>
                    {uploadTooltip.rendered && <Tooltip label="Upload Balance Limit" open={uploadTooltip.open} pos={uploadTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={handleExport} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={13} />
                      <span className="hidden xl:inline">Export</span>
                    </button>
                    {exportTooltip.rendered && <Tooltip label="Export" open={exportTooltip.open} pos={exportTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button
                      type="button"
                      ref={columnsButtonRef}
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="agentbal-columns-popover"
                      aria-label="Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={13} />
                    </button>
                    {columnsTooltip.rendered && <Tooltip label="Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} />}
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
                </div>
              )}
            </div>
            <div className="relative hidden flex-1 min-h-0 sm:block">
              {/* Overlay, not in-flow — centers on this outer (bounded,
                  non-scrolling) container instead of the table's own
                  horizontally-scrollable content width. See
                  TableLoadingSpinner's own comment for why that distinction
                  matters once a table has enough columns to overflow. */}
              {loading && <TableLoadingSpinner overlay />}
              <div
                ref={tableScrollRef}
                className={`dt-scroll h-full ${
                  loading ? 'overflow-hidden pointer-events-none' : 'overflow-y-auto overflow-x-auto pointer-events-auto'
                }`}
              >
              <table className="w-full text-xs">
                <thead className={`sticky top-0 z-[50] bg-[#FAFBFC] dark:bg-[#0E1119] border-b border-[#E2E8F0] dark:border-[#262B38] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[38px]">
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={colWidthsPx[col.key] ? { width: colWidthsPx[col.key], minWidth: colWidthsPx[col.key] } : undefined}
                        className={headerCellClasses(col.key, sortColumn === col.key)}>
                        {/* Header shimmers along with the body during
                            loading, per explicit instruction — reverses the
                            earlier "headers are never placeholders" spec. */}
                        {loading ? (
                          <div
                            className={`h-[10px] w-3/5 max-w-[58px] dt-skeleton rounded-md ${
                              col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''
                            }`}
                          />
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
                  {rowsPhase !== 'table' ? (
                    // Empty — the loading indicator is the overlay spinner
                    // on the outer container above, not row content here.
                    null
                  ) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    return (
                      <tr
                        key={row.agentName || i}
                        className="dt-row-stagger-in border-b border-[#ECEFF3] last:border-0 dark:border-[#1A1E29] transition-colors duration-150 ease-out hover:bg-slate-50 dark:hover:bg-slate-800"
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
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
              {!loading && isHScrolled && (
                <div className="pointer-events-none absolute inset-y-0 left-0 z-[55] w-6 bg-gradient-to-r from-white to-transparent dark:from-[#12151D] transition-opacity duration-150 ease-out" />
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto sm:hidden">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <TableLoadingSpinner minHeight={8 * 78} />
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
                      <div
                        key={row.agentName || i}
                        className="dt-row-stagger-in rounded-xl border-[0.5px] border-border bg-white p-4 dark:bg-[#12151D]"
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                      >
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
              <CompactTableFooter
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
        </div>
      </main>

      <BalanceLimitUploadModal
        isOpen={balanceLimitModalOpen}
        onClose={() => setBalanceLimitModalOpen(false)}
        product="cashout"
        agentRoster={rows.map((row) => row.agentCode)}
        accentButtonClassName="bg-indigo-600 hover:bg-indigo-700"
        onImported={fetchData}
      />
    </div>
  );
}