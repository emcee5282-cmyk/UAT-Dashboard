'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, RefreshCw, Search, Shuffle } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import Toolbar from '@/app/components/Toolbar';
import DataTable from '@/app/components/DataTable';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '@/app/lib/csv';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';
import { getBusinessToday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';

// Ghost button — copied verbatim from Settlement/Top Up's own toolbar button
// style, replacing this page's old smaller compact buttons.
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-colors duration-150 ease-out hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// 1700 (not 1100) — with 9 columns, every header's own natural width (label
// + balanced spacer + icon, measured via table-layout:auto) sums to ~1600px;
// a lower floor let the container squeeze columns below that on ordinary
// laptop widths, truncating headers even though nothing was actually
// crowded — a horizontal scrollbar on a smaller screen reads better than a
// clipped "Company Balanc…".
const TABLE_MIN_WIDTH_PX = 1760;
const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

function displayNum(num: number): string {
  if (Math.abs(num) < 0.01) return '−';
  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${formatted}` : formatted;
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

function normalizeWalletStatus(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const lower = trimmed.toLowerCase();
  const noSpaces = trimmed.replace(/\s+/g, '').toLowerCase();
  if (noSpaces.includes('dp+wd')) return 'DP+WD';
  if (lower.includes('dp only')) return 'DP Only';
  if (lower.includes('wd only')) return 'WD Only';
  if (lower.includes('top up')) return 'Top Up Acc.';
  if (lower.includes('wallet with issue')) return 'Wallet With Issue';
  if (lower.includes('x group') || lower.includes('disconnected')) return 'Disconnected';
  if (lower.includes('check account problem')) return 'Account Problem';
  return 'Disconnected';
}

function computeWalletStatus(statuses: string[]): string {
  const normalized = statuses
    .map((s) => normalizeWalletStatus(s))
    .filter((s): s is string => s !== null);

  if (normalized.length === 0) return 'Disconnected';

  const has = (label: string) => normalized.includes(label);

  if (has('DP+WD')) return 'DP + WD';
  if (has('DP Only') && has('WD Only')) return 'DP + WD';
  if (has('DP Only')) return 'DP Only';
  if (has('WD Only')) return 'WD Only';
  if (has('Top Up Acc.')) return 'Top Up Acc.';
  if (has('Wallet With Issue')) return 'Wallet With Issue';
  if (has('Account Problem')) return 'Account Problem';

  return 'Disconnected';
}

const EXCLUDED_WALLET_STATUSES = ['Wallet With Issue', 'Disconnected', 'No Record'];

// No Send Money leaders are excluded from SDP VS Balance — Cashout's
// exclusion list doesn't carry over (different leader roster).
const EXCLUDED_SDP_LEADERS: string[] = [];

// Raw gap between Company Balance and SDP, with no display floor — unlike the
// Agent Balance page's own SDP VS Balance column (which only shows values
// over 30,000), the Transfer Queue's own trigger threshold is 8,000, so the
// value can't be pre-floored to 30,000 or the 8,000 gate would never see
// anything between 8,001 and 29,999.
function computeSdpVsBalanceRaw(leader: string, sdpRaw: string, sdpNum: number, companyBalance: number): number {
  const normalizedLeader = leader.trim().toUpperCase();
  if (EXCLUDED_SDP_LEADERS.includes(normalizedLeader)) return 0;

  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  return sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
const SKIP_GROUPS = ['wallet with issue', 'disconnected', 'dc account'];

function computeBrand(groups: string[]): string {
  const counts = new Map<string, number>();
  groups.forEach((group) => {
    const trimmed = (group ?? '').trim();
    if (!trimmed || trimmed === '-') return;
    if (SKIP_GROUPS.some((skip) => trimmed.toLowerCase().includes(skip))) return;
    const code = trimmed.slice(0, 2).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  });

  if (counts.size === 0) return '−';

  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.keys()).filter((code) => counts.get(code) === maxCount);
  const priorityTied = tied.filter((code) => BRAND_PRIORITY.includes(code));

  if (priorityTied.length > 0) {
    priorityTied.sort((a, b) => BRAND_PRIORITY.indexOf(a) - BRAND_PRIORITY.indexOf(b));
    return priorityTied[0];
  }

  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

const BRAND_CODES = [...CASHOUT_BRAND_CODES, 'SH'];
const BRAND_DISPLAY_LABELS: Record<string, string> = { SH: 'Sharing' };

function displayBrand(code: string): string {
  return BRAND_DISPLAY_LABELS[code] ?? code;
}

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−' && BRAND_CODES.includes(brand)) return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

function normalizeGroup(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

// Send Money's own Transfer Queue ruleset (confirmed with user): unlike
// Cashout, there's no DAY variant and no separate "Low Balance"/"Discrepancy"
// group names — every brand below has exactly two possible correct groups,
// "{Brand} 24/7 DP + WD" and "{Brand} 24/7 WD Only". SDP VS Balance > 50,000,
// Discrepancy > 10,000, and Company Balance > 45,000 are independent triggers
// that all point to WD Only (checked first); Company Balance < 20,000 is the
// only trigger for DP + WD. 'SH' (Sharing) has no rule and is never queued.
const QUEUE_BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function resolveCorrectGroup(brand: string, companyBalance: number, sdpVsBalance: number, discrepancy: number): { groupName: string; remarks: string } | null {
  if (!QUEUE_BRAND_CODES.includes(brand)) return null;

  if (sdpVsBalance > 50000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'SDP VS Balance exceeded 50,000' };
  if (discrepancy > 10000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'Discrepancy is higher than 10,000' };
  if (companyBalance > 45000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'Company balance exceeded 45,000' };
  if (companyBalance < 20000) return { groupName: `${brand} 24/7 DP + WD`, remarks: 'Company balance is below 20,000' };

  return null;
}

type QueueRow = {
  key: string;
  shopName: string;
  account: string;
  brand: string;
  currentGroup: string;
  correctGroup: string;
  companyBalance: number;
  discrepancy: number;
  sdpVsBalance: number;
  balanceInside: number;
  remarks: string;
};

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's.
const COLUMN_IDS = {
  BRAND: 'brand',
  SHOP_NAME: 'shopName',
  COMPANY_BALANCE: 'companyBalance',
  BALANCE_INSIDE: 'balanceInside',
  DISCREPANCY: 'discrepancy',
  SDP_VS_BALANCE: 'sdpVsBalance',
  CURRENT_GROUP: 'currentGroup',
  CORRECT_GROUP: 'correctGroup',
  REMARKS: 'remarks',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];

// Column model matches Settlement's ColumnDef shape (`key` kept instead of
// Settlement's `id` since every existing reference on this page already
// reads `col.key`). No protected Actions-style column exists here, so all
// columns are hideable. Brand/Correct Group render a filter-dropdown
// trigger instead of a sort button (see the header JSX further down), so
// they're marked not sortable.
type ColumnDef = {
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

// Every column left-aligned (incl. numeric ones) per explicit instruction —
// a deliberate divergence from Settlement/Top Up/Opening's own convention,
// scoped to this page only.
const DEFAULT_COLUMNS: ColumnDef[] = [
  // Everything center-aligned except Agent, which stays left — explicit
  // instruction (Agent is a code/name, reads better left-anchored; every
  // other column is a short value/label that reads better centered).
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: false, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SHOP_NAME, label: 'Agent', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.BALANCE_INSIDE, label: 'Balance Inside', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DISCREPANCY, label: 'Discrepancy', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SDP_VS_BALANCE, label: 'SDP VS Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  // Current Group / Correct Group / Remarks are 'center' — their data wraps
  // to 2 lines and is center-aligned (see renderCell's `wrapCell`), so the
  // header must match that alignment instead of sitting left while the data
  // floats centered underneath it.
  { key: COLUMN_IDS.CURRENT_GROUP, label: 'Current Group', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.CORRECT_GROUP, label: 'Correct Group', visible: true, sortable: false, hideable: true, align: 'center' },
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyTransferQueueColumnVisibility';

// Rebalanced for 9 left-aligned columns (not copy-pasted from Top Up's own
// 6-column widths) — roughly proportional to each column's own content
// length now that numbers no longer need right-aligned "settling room".
// companyBalance is 11% (not 10% like its same-length siblings) — measured
// via real DOM scrollWidth that "Company Balance" is the one label among
// this group that actually needs the extra ~10px at 14px font-semibold;
// remarks gives up the matching 1% since it degrades gracefully (wraps to
// 2 lines) instead of truncating, unlike a header label.
// shopName (Agent) bumped 12% -> 15% — real account codes run up to ~24
// chars and were truncating even at a normal desktop width (measured
// scrollWidth vs allotted). The 3% comes out of currentGroup/correctGroup/
// remarks (-1% each), which degrade gracefully by wrapping to a 2nd line
// instead of truncating, unlike Agent.
// Re-measured after the header centering fix switched to a "balanced
// invisible spacer" (see the header cells below) — that spacer is a REAL
// flex item now (unlike the old absolute-positioned icon), so every
// center-aligned column's label has less room than before. sdpVsBalance
// +1%/remarks -1% keeps every header's own natural width (measured via
// table-layout:auto) comfortably inside its column at a normal desktop
// width.
const columnWidths: Record<ColumnKey, string> = {
  brand: '8%',
  shopName: '15%',
  companyBalance: '11%',
  balanceInside: '10%',
  discrepancy: '9%',
  sdpVsBalance: '11%',
  currentGroup: '13%',
  correctGroup: '13%',
  remarks: '10%',
};

const rowSkeletonWidths: Record<ColumnKey, string[]> = {
  brand: ['w-8', 'w-10', 'w-9'],
  shopName: ['w-20', 'w-24', 'w-16'],
  companyBalance: ['w-14', 'w-16', 'w-12'],
  balanceInside: ['w-14', 'w-16', 'w-12'],
  discrepancy: ['w-12', 'w-14', 'w-10'],
  sdpVsBalance: ['w-14', 'w-16', 'w-12'],
  currentGroup: ['w-24', 'w-28', 'w-20'],
  correctGroup: ['w-24', 'w-28', 'w-20'],
  remarks: ['w-28', 'w-32', 'w-24'],
};

// 16px both sides (px-4), same for every column regardless of sortability —
// matches the explicit "16px per col both sides" spacing instruction. Font
// size/weight/color copied verbatim from Settlement/Top Up's own header
// cells (text-[14px] font-semibold text-[#475569]) so this page's header
// reads identically to the rest of the app instead of the old legacy 11px.
// overflow-hidden so a long label truncates ("…") instead of visually
// bleeding into the next column when the table is squeezed toward its
// min-width (narrow viewport/browser zoom) — confirmed via screenshot that
// "Company Balance"/"Balance Inside" ran into each other without this.
function headerCellClasses(align: 'left' | 'right' | 'center') {
  return `group overflow-hidden whitespace-nowrap px-4 text-${align} text-[14px] font-semibold text-[#475569] dark:text-[#9CA3AF]`;
}

// Always visible (not opacity-0-until-hover) — same always-on visibility as
// the Brand/Correct Group filter chevrons, so every sortable column reads
// consistently instead of most of them appearing to have no sort control
// at all until the user happens to hover.
// Copied verbatim from Send Money Settlement/Top Up/Opening's own
// SortIcon — same solid ChevronsUpDown at full opacity (not a faded/
// opacity-reduced pair) and the same hardcoded #2563EB active color (not
// var(--product-accent) — those reference pages don't use the accent var
// here either), so this page's sort icon reads exactly as bold/consistent
// as every other migrated Send Money page's.
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

// Per-code tint map — same scheme as Cashout Balance's own BrandBadge
// (app/agentbal/page.tsx), applied here too. Unknown codes (e.g. 'SH') fall
// back to the same neutral slate this badge used exclusively before.
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

// `brand` carries the raw code for the color lookup — `children` is the
// display-relabeled content (e.g. 'SH' -> 'Sharing'), which can differ from
// the raw string.
function BrandBadge({ children, brand }: { children: React.ReactNode; brand: string }) {
  return (
    <span className={`inline-flex h-[28px] items-center rounded-[999px] border px-[10px] text-[12px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${brandBadgeClasses(brand)}`}>
      {children}
    </span>
  );
}

function mobileNumericField(row: QueueRow, key: ColumnKey): { value: string; className: string } {
  switch (key) {
    case 'balanceInside':
      return { value: displayNum(row.balanceInside), className: row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground' };
    case 'discrepancy':
      return { value: displayNum(row.discrepancy), className: 'text-foreground' };
    case 'sdpVsBalance':
      return { value: row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−', className: 'text-foreground' };
    default:
      return { value: '−', className: 'text-foreground' };
  }
}

// One shared base for every column — same 16px both-sides padding, same
// font size/weight (13px/normal, matching Settlement/Top Up's own body
// cells — NOT the old legacy 11px) — per explicit "same font style lang
// lahat" instruction. The only exception is the rose color for a negative
// balance, which is a semantic flag (not a font-style difference).
function renderCell(row: QueueRow, key: ColumnKey) {
  // align-top on every cell (not just the wrapping ones) — rows with a
  // 2-line Current Group/Correct Group/Remarks are taller than the rest,
  // and without this the plain single-line cells vertically CENTER within
  // that taller row while the wrapped cells sit at the top, making the row
  // look uneven/misaligned even though every cell's own text is correct.
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-center px-4 py-[14px] align-top';
  // Agent stays left-aligned per explicit instruction — every other column
  // (short values/labels) reads better centered, but a code/name reads
  // better left-anchored.
  const agentBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-left px-4 py-[14px] align-top';
  // Current Group / Correct Group / Remarks can run long — instead of
  // truncating with "…", these wrap onto a 2nd line (capped at 2 lines) and
  // are center-aligned, per explicit instruction. Every other column stays
  // single-line/left-aligned. The clamp lives on an inner <span>, NOT the
  // <td> itself — line-clamp sets `display: -webkit-box`, which breaks a
  // table cell's own `display: table-cell` and visually collapses/misplaces
  // the cell's content into the wrong column (confirmed via screenshot).
  const wrapCell = 'text-center px-4 py-[14px] align-top';
  const wrapSpan = 'block text-[13px] font-normal whitespace-normal break-words leading-snug line-clamp-2';
  switch (key) {
    case 'brand':
      return <td key={key} className={base}><BrandBadge brand={row.brand}>{displayBrand(row.brand)}</BrandBadge></td>;
    case 'shopName':
      return <td key={key} className={`${agentBase} text-foreground`}>{row.account}</td>;
    case 'companyBalance':
      return (
        <td key={key} className={`${base} tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {displayNum(row.companyBalance)}
        </td>
      );
    case 'balanceInside':
      return (
        <td key={key} className={`${base} tabular-nums ${row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {displayNum(row.balanceInside)}
        </td>
      );
    case 'discrepancy':
      return (
        <td key={key} className={`${base} tabular-nums text-foreground`}>
          {displayNum(row.discrepancy)}
        </td>
      );
    case 'sdpVsBalance':
      return (
        <td key={key} className={`${base} tabular-nums text-foreground`}>
          {row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−'}
        </td>
      );
    case 'currentGroup':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{row.currentGroup}</span></td>;
    case 'correctGroup':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{row.correctGroup}</span></td>;
    case 'remarks':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{row.remarks}</span></td>;
  }
}

export default function SendMoneyTransferQueue() {
  const [queueRows, setQueueRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [correctGroupFilter, setCorrectGroupFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [correctGroupMenuOpen, setCorrectGroupMenuOpen] = useState(false);
  const [correctGroupMenuPos, setCorrectGroupMenuPos] = useState({ top: 0, left: 0 });
  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsMenuPos, setColumnsMenuPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const correctGroupButtonRef = useRef<HTMLButtonElement>(null);
  const correctGroupDropdownRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  // Sticky-header scroll shadow — copied from Settlement/Top Up's own pattern.
  const [isScrolled, setIsScrolled] = useState(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  // Small left/right edge-fade cues on the horizontally-scrollable table,
  // so text at the boundary doesn't look abruptly cut off — shown only
  // while there's actually more content to scroll to in that direction.
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

      // Reuses Cashout's own /api/opening as-is for the roster, plus two
      // Send Money-specific routes: /api/sendmoney/balances ("SSP PS
      // BalanceLimit") and /api/sendmoney/stlmtopup ("PS BD STLM + TOPUP",
      // Send Money's own dedicated Settlement + Top Up sheet) — same three
      // sources as /sendmoney/balances.
      const [openingRes, balRes, stlmRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();

      const openingRawRows = parseCsvLines(openingText);
      // Top Up/Settlement totals reset at the 2AM business-day rollover
      // (see app/lib/businessDate.ts) — clock-based, not gated on whether
      // Opening's own "Updated Time" card has been manually refreshed yet.
      const reportCutoffDate = getBusinessToday();

      // Send Money's own roster lives in cols L-O (indices 11-14) of "Opening AG".
      const openingRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[11]),
          openingBal: rawVal(row[12]),
          sdp: rawVal(row[13]),
          leader: rawVal(row[14]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      // "SSP PS BalanceLimit" lines up with Cashout's own Balance Limit sheet
      // from index 4 onward, just without Cashout's leading "Reference" column.
      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[0]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          balance: rawVal(row[8]),
          login: rawVal(row[15]),
          accountStatus: rawVal(row[1]),
          group: rawVal(row[6]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      const walletStatusValues = new Map<string, string[]>();
      const brandGroups = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
        balanceTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

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

        if (bal.login.trim().toLowerCase() === 'yes') {
          const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
        }
      });

      // "PS BD STLM + TOPUP" is Send Money's own dedicated sheet (replaces
      // the old shared "Stlm Top Up" cols A-G source). Top Up lives in cols
      // B-F (indices 1-5), amounts stored positive; Settlement lives in cols
      // H-L (indices 7-11), amounts stored negative (money leaving) so
      // they're abs()'d — same cutoff-date filtering as /sendmoney/balances
      // so rows already folded into the last Opening Balance reset aren't
      // double-counted.
      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = rawVal(row[1]);
          const topUpAmount = rawVal(row[2]);
          const topUpDate = reportCutoffDate ? parseSheetDate(rawVal(row[3])) : null;
          if (
            topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
            (!reportCutoffDate || (topUpDate && topUpDate >= reportCutoffDate))
          ) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = rawVal(row[7]);
          const stlmAmount = rawVal(row[8]);
          const stlmDate = reportCutoffDate ? parseSheetDate(rawVal(row[9])) : null;
          if (
            stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
            (!reportCutoffDate || (stlmDate && stlmDate >= reportCutoffDate))
          ) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const agentInfo = new Map<string, { companyBalance: number; sdpVsBalance: number; discrepancy: number; balanceInside: number; walletStatus: string; brand: string }>();
      openingRows.forEach((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
        const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
        const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
        const companyBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
        const sdpNum = parseNumber(opening.sdp);
        const walletStatus = balWalletNames.has(opening.agentName)
          ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
          : 'No Record';

        agentInfo.set(opening.agentName, {
          companyBalance,
          sdpVsBalance: computeSdpVsBalanceRaw(opening.leader, opening.sdp, sdpNum, companyBalance),
          discrepancy: companyBalance - balanceInside,
          balanceInside,
          walletStatus,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName),
        });
      });

      const queue: QueueRow[] = [];
      balRows.forEach((bal, index) => {
        const info = agentInfo.get(bal.walletName);
        if (!info) return;
        if (EXCLUDED_WALLET_STATUSES.includes(info.walletStatus)) return;

        const currentGroup = bal.group.trim();
        if (currentGroup.toLowerCase().includes('top up')) return;
        // Shops whose wallet name carries a "BD" segment (e.g. "D-M2BD-DELTA063-NG")
        // are excluded from the Transfer Queue entirely, per user instruction.
        if (bal.walletName.toUpperCase().includes('BD')) return;
        const resolved = resolveCorrectGroup(info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy);
        if (!resolved) return;
        if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

        queue.push({
          key: `${bal.walletName}-${index}`,
          shopName: bal.walletName,
          account: bal.walletName,
          brand: info.brand,
          currentGroup,
          correctGroup: resolved.groupName,
          companyBalance: info.companyBalance,
          discrepancy: info.discrepancy,
          sdpVsBalance: info.sdpVsBalance,
          balanceInside: info.balanceInside,
          remarks: resolved.remarks,
        });
      });

      setQueueRows(queue);
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
  }, [searchTerm, brandFilter, correctGroupFilter, sortColumn, sortDirection, rowsPerPage]);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  useEffect(() => {
    if (!brandMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        brandButtonRef.current && !brandButtonRef.current.contains(target) &&
        brandDropdownRef.current && !brandDropdownRef.current.contains(target)
      ) {
        setBrandMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [brandMenuOpen]);

  useEffect(() => {
    if (!correctGroupMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        correctGroupButtonRef.current && !correctGroupButtonRef.current.contains(target) &&
        correctGroupDropdownRef.current && !correctGroupDropdownRef.current.contains(target)
      ) {
        setCorrectGroupMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [correctGroupMenuOpen]);

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

  useEffect(() => {
    if (!columnsMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        columnsButtonRef.current && !columnsButtonRef.current.contains(target) &&
        columnsMenuRef.current && !columnsMenuRef.current.contains(target)
      ) {
        setColumnsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setColumnsMenuOpen(false);
        columnsButtonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [columnsMenuOpen]);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    const firstControl = columnsMenuRef.current?.querySelector<HTMLElement>('input, button');
    firstControl?.focus();
  }, [columnsMenuOpen]);

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return queueRows;
    return queueRows.filter((row) =>
      `${row.shopName} ${row.currentGroup} ${row.correctGroup}`.toLowerCase().includes(query)
    );
  }, [queueRows, searchTerm]);

  const brandOptions = useMemo(() => {
    const rows = searchedRows.filter((row) => correctGroupFilter[row.correctGroup] !== false);
    return Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [searchedRows, correctGroupFilter]);
  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const correctGroupOptions = useMemo(() => {
    const rows = searchedRows.filter((row) => brandFilter[row.brand] !== false);
    return Array.from(new Set(rows.map((row) => row.correctGroup).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [searchedRows, brandFilter]);
  const isCorrectGroupChecked = (name: string) => correctGroupFilter[name] !== false;
  const allCorrectGroupsChecked = correctGroupOptions.every((name) => isCorrectGroupChecked(name));
  const anyCorrectGroupUnchecked = correctGroupOptions.some((name) => !isCorrectGroupChecked(name));
  const selectedCorrectGroupCount = correctGroupOptions.filter((name) => isCorrectGroupChecked(name)).length;

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (correctGroupOptions.some((name) => correctGroupFilter[name] === false)) {
      list = list.filter((row) => correctGroupFilter[row.correctGroup] !== false);
    }
    return list;
  }, [searchedRows, brandFilter, brandOptions, correctGroupFilter, correctGroupOptions]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: QueueRow, column: ColumnKey) => {
        switch (column) {
          case 'brand':
            return displayBrand(row.brand).toLowerCase();
          case 'shopName':
            return row.account.toLowerCase();
          case 'companyBalance':
            return row.companyBalance;
          case 'balanceInside':
            return row.balanceInside;
          case 'discrepancy':
            return row.discrepancy;
          case 'sdpVsBalance':
            return row.sdpVsBalance;
          case 'currentGroup':
            return row.currentGroup.toLowerCase();
          case 'correctGroup':
            return row.correctGroup.toLowerCase();
          case 'remarks':
            return row.remarks.toLowerCase();
          default:
            return row.companyBalance;
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
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, startIndex + rowsPerPage);

  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );
  const visibleHideableCount = useMemo(
    () => columnDefs.filter((col) => col.hideable && col.visible).length,
    [columnDefs]
  );
  const columnVisibility = useMemo(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, col.visible])) as Record<ColumnKey, boolean>,
    [columnDefs]
  );

  const handleExport = useCallback(() => {
    const getExportValue = (row: QueueRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return displayBrand(row.brand);
        case 'shopName':
          return row.account;
        case 'companyBalance':
          return row.companyBalance;
        case 'balanceInside':
          return row.balanceInside;
        case 'discrepancy':
          return row.discrepancy;
        case 'sdpVsBalance':
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined;
        case 'currentGroup':
          return row.currentGroup;
        case 'correctGroup':
          return row.correctGroup;
        case 'remarks':
          return row.remarks;
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transfer Queue');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_TRANSFER_QUEUE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <SettlementHeader
        icon={Shuffle}
        title="Transfer Queue"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />

      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-4">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
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
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = columnsButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          const dropdownWidth = 224;
                          const left = Math.max(8, Math.min(rect.right - dropdownWidth, window.innerWidth - dropdownWidth - 8));
                          setColumnsMenuPos({ top: rect.bottom + 8, left });
                        }
                        setColumnsMenuOpen((current) => !current);
                      }}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="sendmoney-transfer-queue-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className={GHOST_BUTTON}
                    >
                      <Columns3 size={15} />
                      Columns
                    </button>
                    {columnsMenuOpen && typeof document !== 'undefined' && createPortal(
                      <div
                        ref={columnsMenuRef}
                        id="sendmoney-transfer-queue-columns-popover"
                        role="dialog"
                        aria-label="Column visibility"
                        style={{ position: 'fixed', top: columnsMenuPos.top, left: columnsMenuPos.left }}
                        className="z-[9999] w-56 max-h-[70vh] overflow-y-auto rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setColumnsMenuOpen(false);
                            columnsButtonRef.current?.focus();
                          }
                        }}
                      >
                        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Columns</div>
                        {columnDefs.filter((col) => col.hideable).map((col) => {
                          const isLastVisible = col.visible && visibleHideableCount === 1;
                          return (
                            <label
                              key={col.key}
                              title={isLastVisible ? 'At least one column must stay visible' : undefined}
                              className={`flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] ${
                                isLastVisible
                                  ? 'cursor-not-allowed text-[#b3b8c2] dark:text-[#5a5f66]'
                                  : 'text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={col.visible}
                                disabled={isLastVisible}
                                onChange={() => {
                                  setColumnDefs((current) =>
                                    current.map((c) => (c.key === col.key ? { ...c, visible: !c.visible } : c))
                                  );
                                }}
                              />
                              <span className="min-w-0 flex-1 truncate">{col.label}</span>
                            </label>
                          );
                        })}
                        <div className="mt-1 border-t border-[#F1F5F9] pt-1 dark:border-[#2f2f32]">
                          {/* Hardcoded teal, not var(--product-accent): this popover
                              portals to document.body, a sibling of the
                              [data-product="sendmoney"] div the variable is scoped
                              to (see globals.css), so the var resolves to nothing
                              here — confirmed via computed-style check. */}
                          <button
                            type="button"
                            onClick={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                            className="flex w-full items-center justify-center rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-[#0d9488] transition-colors hover:bg-[rgba(13,148,136,0.08)] dark:hover:bg-[rgba(45,212,191,0.12)]"
                          >
                            Restore Defaults
                          </button>
                        </div>
                      </div>,
                      document.body
                    )}
                  </div>
                )}
              </Toolbar.Right>
            </Toolbar>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-xs" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[48px]">
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        className={headerCellClasses(col.align)}>
                        {/* Header always renders its real label/sort control,
                            loading or not — only data rows shimmer (premium
                            skeleton spec: headers are never placeholders,
                            matching Settlement/Top Up's own convention). */}
                        {col.key === 'brand' ? (
                          // A mirrored INVISIBLE copy of the button sits on the
                          // opposite side of the label, same width as the real
                          // one — this "balanced spacer" trick centers the
                          // LABEL itself (matching the data's true center)
                          // while keeping a normal, consistent gap between the
                          // label and the real button (an absolute-positioned
                          // icon put them at inconsistent/overlapping distances
                          // depending on the label's own rendered width).
                          <div className="flex w-full items-center justify-center gap-0.5">
                            <span aria-hidden="true" className="invisible flex items-center justify-center rounded-full p-1">
                              {anyBrandUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedBrandCount}
                                </span>
                              ) : (
                                <ChevronUp size={12} />
                              )}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{col.label}</span>
                            <button
                              type="button"
                              ref={brandButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = brandButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setBrandMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyBrandUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedBrandCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${brandMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {brandMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={brandDropdownRef}
                                style={{ position: 'fixed', top: brandMenuPos.top, left: brandMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Brand</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allBrandsChecked}
                                      onChange={() => {
                                        const nextValue = !allBrandsChecked;
                                        setBrandFilter(Object.fromEntries(brandOptions.map((name) => [name, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {brandOptions.map((brand) => (
                                    <label key={brand} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isBrandChecked(brand)}
                                        onChange={() => {
                                          setBrandFilter((current) => ({ ...current, [brand]: !isBrandChecked(brand) }));
                                        }}
                                      />
                                      <span>{displayBrand(brand)}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.key === 'correctGroup' ? (
                          // A mirrored INVISIBLE copy of the button sits on the
                          // opposite side of the label, same width as the real
                          // one — this "balanced spacer" trick centers the
                          // LABEL itself (matching the data's true center)
                          // while keeping a normal, consistent gap between the
                          // label and the real button (an absolute-positioned
                          // icon put them at inconsistent/overlapping distances
                          // depending on the label's own rendered width).
                          <div className="flex w-full items-center justify-center gap-0.5">
                            <span aria-hidden="true" className="invisible flex items-center justify-center rounded-full p-1">
                              {anyCorrectGroupUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedCorrectGroupCount}
                                </span>
                              ) : (
                                <ChevronUp size={12} />
                              )}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{col.label}</span>
                            <button
                              type="button"
                              ref={correctGroupButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = correctGroupButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 288;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setCorrectGroupMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setCorrectGroupMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyCorrectGroupUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyCorrectGroupUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedCorrectGroupCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${correctGroupMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {correctGroupMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={correctGroupDropdownRef}
                                style={{ position: 'fixed', top: correctGroupMenuPos.top, left: correctGroupMenuPos.left }}
                                className="z-[9999] w-72 max-w-[90vw] rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Correct Group</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allCorrectGroupsChecked}
                                      onChange={() => {
                                        const nextValue = !allCorrectGroupsChecked;
                                        setCorrectGroupFilter(Object.fromEntries(correctGroupOptions.map((name) => [name, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {correctGroupOptions.map((group) => (
                                    <label key={group} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isCorrectGroupChecked(group)}
                                        onChange={() => {
                                          setCorrectGroupFilter((current) => ({ ...current, [group]: !isCorrectGroupChecked(group) }));
                                        }}
                                      />
                                      <span>{group}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : (
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
                              // A mirrored INVISIBLE copy of the icon sits on
                              // the opposite side of the label — same
                              // "balanced spacer" trick as Brand/Correct Group
                              // above, so the LABEL centers on the data's true
                              // center while keeping a normal, consistent gap
                              // to the icon (an absolute-positioned icon put
                              // them at inconsistent/overlapping distances
                              // depending on the label's own rendered width).
                              <span aria-hidden="true" className="invisible">
                                <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                              </span>
                            )}
                            {/* flex-1 only for center-aligned columns — it's
                                what lets the label's own text-center (inherited
                                from the <th>) land on the true row center. For
                                a LEFT-aligned column (Agent), flex-1 would still
                                grow the label's box to fill the whole row, so
                                text-left renders the text flush left same as
                                before but leaves a big empty gap between the
                                text and the icon sitting at the far edge of
                                that oversized box — Agent needs the label sized
                                to its own (shrinkable) content only, so the
                                icon sits directly after it via the row's own
                                gap-1.5, not stranded at the column's far edge. */}
                            <span className={`min-w-0 truncate ${col.align === 'center' ? 'flex-1' : ''}`}>{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                          </button>
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
                          return (
                            <td key={col.key} className="px-4 py-[14px]">
                              <div className={`dt-skeleton h-2.5 rounded-md ${width}`} />
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  ) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={row.key} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)}>
                        <EmptyState
                          title="No accounts need transfer"
                          description="Queue is clear — nothing currently needs rebalancing."
                        />
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
                    const showAgent = columnVisibility.shopName;
                    const showBrand = columnVisibility.brand;
                    const showBalance = columnVisibility.companyBalance;
                    const numericFields = visibleColumns.filter((col) =>
                      (['balanceInside', 'discrepancy', 'sdpVsBalance'] as ColumnKey[]).includes(col.key)
                    );
                    const showCurrentGroup = columnVisibility.currentGroup;
                    const showCorrectGroup = columnVisibility.correctGroup;
                    const showRemarks = columnVisibility.remarks;
                    return (
                      <div key={row.key} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                        {(showAgent || showBrand) && (
                          <div className="flex items-start justify-between gap-2">
                            {showAgent && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.account}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{displayBrand(row.brand)}</span>}
                          </div>
                        )}

                        {showBalance && (
                          <div className={`flex items-baseline justify-between ${(showAgent || showBrand) ? 'mt-2.5' : ''}`}>
                            <span className="text-[10px] font-medium text-muted-foreground">Company Balance</span>
                            <span className={`text-lg font-bold tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {displayNum(row.companyBalance)}
                            </span>
                          </div>
                        )}

                        {numericFields.length > 0 && (
                          <div className={`grid grid-cols-3 gap-2 ${(showAgent || showBrand || showBalance) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {numericFields.map((col) => {
                              const { value, className } = mobileNumericField(row, col.key);
                              return (
                                <div key={col.key}>
                                  <p className="text-[9px] font-medium text-muted-foreground">{col.label}</p>
                                  <p className={`text-[11px] font-semibold tabular-nums ${className}`}>{value}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {(showCurrentGroup || showCorrectGroup) && (
                          <div className={`space-y-1.5 ${(showAgent || showBrand || showBalance || numericFields.length > 0) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showCurrentGroup && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Current Group</p>
                                <p className="text-[11px] text-muted-foreground">{row.currentGroup}</p>
                              </div>
                            )}
                            {showCorrectGroup && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Correct Group</p>
                                <p className="text-[11px] font-medium text-foreground">{row.correctGroup}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {showRemarks && row.remarks && (
                          <p className="mt-2 text-[10px] text-muted-foreground">{row.remarks}</p>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    title="No accounts need transfer"
                    description="Queue is clear — nothing currently needs rebalancing."
                  />
                )}
              </div>
            </div>

            {!loading && (
              <TableFooter
                recordCountText={
                  sortedRows.length === 0
                    ? 'Showing 0 of 0 Accounts'
                    : `Showing ${startIndex + 1}–${Math.min(startIndex + rowsPerPage, sortedRows.length)} of ${sortedRows.length} Accounts`
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
