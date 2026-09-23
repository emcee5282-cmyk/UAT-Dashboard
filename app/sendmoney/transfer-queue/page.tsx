'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, Layers, Search, Shuffle } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import FilterDropdown from '@/app/components/FilterDropdown';
import ColumnsDropdown from '@/app/components/ColumnsDropdown';
import DataTable from '@/app/components/DataTable';
import CompactTableFooter from '@/app/components/CompactTableFooter';
import EmptyState from '@/app/components/EmptyState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '@/app/lib/csv';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';
import { getBusinessToday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';
import { resolveSendMoneyCorrectGroup, shouldExcludeBdWallet, normalizeGroup, type RuleRow } from '@/app/lib/transferQueueRules';
import { computeCashoutCompanyBalanceByAgent } from '@/app/lib/cashoutAgentBalance';

async function fetchEffectiveTransferQueueRules(): Promise<RuleRow[]> {
  const res = await fetch(`/api/configurations/transfer-queue-settings/effective?t=${Date.now()}`);
  if (!res.ok) throw new Error('Failed to fetch Transfer Queue configuration');
  const data: { rules: RuleRow[] } = await res.json();
  return data.rules;
}

// LOCALHOST-ONLY, page-scoped data-source override — same shared flag as
// app/transfer-queue/page.tsx (Phase 2 wires both products behind it
// together). Explicit opt-in only: any value other than the literal
// 'postgres' keeps this page on Google Sheets, its always-safe default.
function isPostgresSourceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRANSFER_QUEUE_SOURCE === 'postgres';
}

// Matches app/lib/services/transferQueueService.ts's TransferQueueRow shape.
type PgTransferQueueRow = {
  agentId: number;
  walletId: number;
  agentCode: string;
  account: string;
  brand: string;
  currentGroup: string;
  correctGroup: string;
  companyBalance: number;
  discrepancy: number;
  sdpVsBalance: number;
  balanceInside: number;
  remarks: string;
  walletStatus: string;
};

// Responsive toolbar buttons, matching Agent Balance's own convention
// exactly (app/agentbal/page.tsx's ICON_BUTTON/ICON_ONLY_BUTTON) — icon-only
// below the `xl:` breakpoint, label revealed only once there's room, rather
// than a fixed-width icon+label button that never adapts. Export keeps the
// responsive reveal; Columns stays icon-only always, per explicit
// instruction to match Settlement/Top Up/Agent Balance's own Columns button.
const ICON_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const ICON_ONLY_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Compact sizing (matches Cashout Transfer Queue's density): font/padding/
// row height scaled down, which shrinks every header's own natural width
// proportionally — floor trimmed from 1760 to 1400 to match. Trimmed again
// to 1360 when Brand dropped its badge (see columnWidths' own comment) —
// every other column's pixel width is unchanged, only the table's total
// width (and therefore how much it overflows/scrolls) shrank.
const TABLE_MIN_WIDTH_PX = 1360;
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
// 'SH' shows as-is (no override) per explicit instruction, matching the
// Wallet Status page's own Brand column.
const BRAND_DISPLAY_LABELS: Record<string, string> = {};

function displayBrand(code: string): string {
  return BRAND_DISPLAY_LABELS[code] ?? code;
}

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−' && BRAND_CODES.includes(brand)) return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
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
// columns are hideable.
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
// Text columns left-aligned, numeric columns right-aligned — Current
// Group/Correct Group/Remarks wrap to 2 lines (see renderCell's
// `wrapCell`) but are still text, so they're left too, matching their
// header.
const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.SHOP_NAME, label: 'Shop Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.BALANCE_INSIDE, label: 'Balance Inside', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.DISCREPANCY, label: 'Discrepancy', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.SDP_VS_BALANCE, label: 'SDP VS Balance', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.CURRENT_GROUP, label: 'Current Group', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.CORRECT_GROUP, label: 'Correct Group', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'left' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyTransferQueueColumnVisibility';

// Brand dropped from a 22px-tall pill badge to plain text (matches every
// other page's own Brand column), so its column no longer needs room for a
// circular chip — shrunk from 112px to 72px. First pass went to 48px, but
// that clipped the HEADER LABEL itself ("Brand" + sort icon truncated to
// "B…") — the header must stay fully readable, per explicit follow-up, so
// 72px is the floor (data cells only need ~20px for a 2-char code; the
// header text is what actually constrains this column). Every OTHER
// column's percentage below is recalculated so its ABSOLUTE pixel width is
// unchanged from before (only Brand actually shrinks) — the freed 40px
// comes off TABLE_MIN_WIDTH_PX itself (1400 -> 1360), which is what
// actually reduces the table's total width/horizontal overflow. Shop Name/
// Company Balance were separately trimmed to reclaim dead space, handed to
// Remarks — verified safe against the FULL live dataset (3,658 rows):
// longest real Shop Name needs 159px text (181px with padding) against its
// 198px column; longest Company Balance needs 56px text (89px with
// padding) against its 147px column — comfortable margin on both, no
// truncation risk.
const columnWidths: Record<ColumnKey, string> = {
  brand: '5.29%',
  shopName: '14.56%',
  companyBalance: '10.81%',
  balanceInside: '10.29%',
  discrepancy: '9.26%',
  sdpVsBalance: '11.32%',
  currentGroup: '13.38%',
  correctGroup: '13.38%',
  remarks: '11.69%',
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
  return `group overflow-hidden whitespace-nowrap px-[8px] text-${align} text-[12px] font-semibold text-[#475569] dark:text-[#9CA3AF]`;
}

// Always visible (not opacity-0-until-hover) — same always-on visibility as
// the Brand/Correct Group filter chevrons, so every sortable column reads
// consistently instead of most of them appearing to have no sort control
// at all until the user happens to hover.
// Copied verbatim from Send Money Settlement/Top Up/Opening's own
// SortIcon — same solid ChevronsUpDown at full opacity (not a faded/
// opacity-reduced pair) and the same hardcoded var(--ui-accent) active color (not
// var(--ui-accent) — those reference pages don't use the accent var
// here either), so this page's sort icon reads exactly as bold/consistent
// as every other migrated Send Money page's.
function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  return (
    <span className="flex w-[11px] shrink-0 items-center justify-center transition-colors duration-150 ease-out">
      {!active ? (
        <ChevronsUpDown size={11} className="text-[#94A3B8]" />
      ) : direction === 'asc' ? (
        <ChevronUp size={11} className="text-[var(--ui-accent)]" />
      ) : (
        <ChevronDown size={11} className="text-[var(--ui-accent)]" />
      )}
    </span>
  );
}

// Blue text, no background — same accent pair (`var(--ui-accent)` / dark `#60A5FA`)
// already used app-wide for active/interactive text (sort icons, TableFooter
// "Show", ColumnsDropdown reset), not the old yellow/blue-fill <mark>.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-transparent font-medium text-[var(--ui-accent)] no-underline dark:text-[#60A5FA]">{part}</mark>
    ) : (
      part
    )
  );
}

// Mirrors renderCell's per-column display text — the single source of truth
// for what "global search across every visible column" actually searches,
// so a match always corresponds to text the user can literally see on
// screen (and highlightMatch above can always find it to underline).
function searchableCellText(row: QueueRow, key: ColumnKey): string {
  switch (key) {
    case 'brand':
      return displayBrand(row.brand);
    case 'shopName':
      return row.account;
    case 'companyBalance':
      return displayNum(row.companyBalance);
    case 'balanceInside':
      return displayNum(row.balanceInside);
    case 'discrepancy':
      return displayNum(row.discrepancy);
    case 'sdpVsBalance':
      return row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '';
    case 'currentGroup':
      return row.currentGroup;
    case 'correctGroup':
      return row.correctGroup;
    case 'remarks':
      return row.remarks;
    default:
      return '';
  }
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
function renderCell(row: QueueRow, key: ColumnKey, searchTerm: string) {
  // align-middle on every cell, uniformly — a mixed top/center split (only
  // the wrapping cells pinned top, everything else centered) was tried
  // before and looked uneven, since a single-line cell's centered text
  // wouldn't land on either line of a 2-line neighbor. Centering EVERY
  // cell, including the wrapping ones, avoids that mismatch: a single-line
  // cell's text now lands at the row's true vertical middle, which for a
  // 2-line neighbor falls naturally between its two lines — and it clears
  // the large dead space that used to sit under short single-line values
  // (Shop Name, etc.) whenever a sibling cell in the same row wrapped to a
  // 2nd line.
  const leftBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-normal text-left px-[8px] py-[11px] align-middle';
  // Right padding is NOT symmetric with the left — the header's sort icon
  // sits flush at the column's true right edge (no balanced spacer for
  // right-aligned columns, see the header button below), so the header
  // label's own right edge sits inset by that icon+gap gutter, not the
  // cell's true edge. The data's right edge has to match that same inset
  // or the header word and the numbers below it drift out of alignment.
  const rightBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-normal text-right pl-[8px] pr-[25px] align-middle';
  // Current Group / Correct Group / Remarks can run long — instead of
  // truncating with "…", these wrap onto a 2nd line (capped at 2 lines).
  // Left-aligned like every other text column. The clamp lives on an
  // inner <span>, NOT the <td> itself — line-clamp sets
  // `display: -webkit-box`, which breaks a table cell's own
  // `display: table-cell` and visually collapses/misplaces the cell's
  // content into the wrong column (confirmed via screenshot).
  const wrapCell = 'text-left px-[8px] py-[11px] align-middle';
  const wrapSpan = 'block text-[11px] font-normal whitespace-normal break-words leading-snug line-clamp-2';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${leftBase} text-foreground`}>{highlightMatch(displayBrand(row.brand), searchTerm)}</td>;
    case 'shopName':
      return <td key={key} className={`${leftBase} text-foreground`}>{highlightMatch(row.account, searchTerm)}</td>;
    case 'companyBalance':
      return (
        <td key={key} className={`${rightBase} tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {highlightMatch(displayNum(row.companyBalance), searchTerm)}
        </td>
      );
    case 'balanceInside':
      return (
        <td key={key} className={`${rightBase} tabular-nums ${row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {highlightMatch(displayNum(row.balanceInside), searchTerm)}
        </td>
      );
    case 'discrepancy':
      return (
        <td key={key} className={`${rightBase} font-[440]! tabular-nums text-foreground`}>
          {highlightMatch(displayNum(row.discrepancy), searchTerm)}
        </td>
      );
    case 'sdpVsBalance':
      return (
        <td key={key} className={`${rightBase} tabular-nums text-foreground`}>
          {row.sdpVsBalance > 0 ? highlightMatch(displayNum(Math.abs(row.sdpVsBalance)), searchTerm) : '−'}
        </td>
      );
    case 'currentGroup':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{highlightMatch(row.currentGroup, searchTerm)}</span></td>;
    case 'correctGroup':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{highlightMatch(row.correctGroup, searchTerm)}</span></td>;
    case 'remarks':
      return <td key={key} className={wrapCell}><span className={`${wrapSpan} text-foreground`}>{highlightMatch(row.remarks, searchTerm)}</span></td>;
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
  const [correctGroupFilter, setCorrectGroupFilter] = useState<Record<string, boolean>>({});
  const [correctGroupMenuOpen, setCorrectGroupMenuOpen] = useState(false);
  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);

  const correctGroupButtonRef = useRef<HTMLButtonElement>(null);
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

      if (isPostgresSourceEnabled()) {
        // Postgres path — /api/v2/transfer-queue already computes every
        // field server-side (transferQueueService.ts, reusing
        // balanceService.ts's getAgentBalances() for Company Balance/
        // Balance Inside/Discrepancy — the exact same figures the Balance
        // page shows — and the unchanged transferQueueRules.ts resolvers
        // for Correct Group/Remarks), so this only maps field names onto
        // QueueRow — no calculation is duplicated here.
        const res = await fetch(`/api/v2/transfer-queue?product=sendmoney&t=${Date.now()}`);
        await assertAllOk([res]);
        const data: { rows: PgTransferQueueRow[] } = await res.json();
        const queue: QueueRow[] = data.rows.map((row) => ({
          key: `${row.agentCode}-${row.walletId}`,
          shopName: row.agentCode,
          account: row.account,
          brand: row.brand,
          currentGroup: row.currentGroup,
          correctGroup: row.correctGroup,
          companyBalance: row.companyBalance,
          discrepancy: row.discrepancy,
          sdpVsBalance: row.sdpVsBalance,
          balanceInside: row.balanceInside,
          remarks: row.remarks,
        }));
        setQueueRows(queue);
        return;
      }

      // Reuses Cashout's own /api/opening as-is for the roster, plus two
      // Send Money-specific routes: /api/sendmoney/balances ("SSP PS
      // BalanceLimit") and /api/sendmoney/stlmtopup ("PS BD STLM + TOPUP",
      // Send Money's own dedicated Settlement + Top Up sheet) — same three
      // sources as /sendmoney/balances. Plus 2 new Cashout-side fetches +
      // the linked-accounts lookup, needed only for Bundle (BD) wallets —
      // see app/lib/cashoutAgentBalance.ts's own header comment.
      const [openingRes, balRes, stlmRes, agentBalRes, agstlmRes, linkedAccountsRes, rules] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/configurations/transfer-queue-settings/linked-accounts?t=${Date.now()}`),
        fetchEffectiveTransferQueueRules(),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, agentBalRes, agstlmRes, linkedAccountsRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();
      const cashoutCompanyBalanceByAgent = computeCashoutCompanyBalanceByAgent(openingText, await agentBalRes.text(), await agstlmRes.text());
      const linkedAccounts: Record<string, string> = await linkedAccountsRes.json();

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

        let resolved: ReturnType<typeof resolveSendMoneyCorrectGroup>;
        if (currentGroup.toUpperCase().startsWith('SH')) {
          // SH-prefixed labels (virtually every real Send Money shop today)
          // skip the legacy BD-exclusion gate entirely — Bundle wallets are
          // evaluated against their linked Cashout account's own Company
          // Balance instead (see app/lib/cashoutAgentBalance.ts).
          const linkedTo = linkedAccounts[bal.walletName.toUpperCase()];
          const cashoutAccountBalance = linkedTo ? (cashoutCompanyBalanceByAgent.get(linkedTo) ?? null) : null;
          resolved = resolveSendMoneyCorrectGroup(currentGroup, bal.walletName, info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy, cashoutAccountBalance, rules);
        } else {
          // Legacy path — shops whose wallet name carries a "BD" segment
          // (e.g. "D-M2BD-DELTA063-NG") are excluded from the Transfer
          // Queue by default (keyword gate, always checked first) — unless
          // an enabled BD Limit Configuration rule says otherwise.
          if (shouldExcludeBdWallet(bal.walletName, info.companyBalance, info.sdpVsBalance, info.discrepancy, rules)) return;
          resolved = resolveSendMoneyCorrectGroup(currentGroup, bal.walletName, info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy, null, rules);
        }
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
  }, [searchTerm, correctGroupFilter, sortColumn, sortDirection, rowsPerPage]);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

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

  // Global search: scoped to whichever columns are currently toggled visible
  // (via the Columns dropdown), not a fixed subset — hide a column and it
  // drops out of search scope too, so a match always traces back to
  // something the user can actually see highlighted in the table.
  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return queueRows;
    const visibleKeys = columnDefs.filter((c) => c.visible).map((c) => c.key);
    return queueRows.filter((row) => {
      const haystack = visibleKeys.map((key) => searchableCellText(row, key)).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [queueRows, searchTerm, columnDefs]);

  const correctGroupOptions = useMemo(() => {
    return Array.from(new Set(searchedRows.map((row) => row.correctGroup).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [searchedRows]);
  const isCorrectGroupChecked = (name: string) => correctGroupFilter[name] !== false;
  const anyCorrectGroupUnchecked = correctGroupOptions.some((name) => !isCorrectGroupChecked(name));
  const selectedCorrectGroupCount = correctGroupOptions.filter((name) => isCorrectGroupChecked(name)).length;

  // Toolbar filter panel (shared FilterDropdown component) needs per-option
  // row counts, unlike the old header-embedded checkbox list which showed
  // bare names only.
  const correctGroupFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of searchedRows) {
      if (!row.correctGroup) continue;
      counts.set(row.correctGroup, (counts.get(row.correctGroup) ?? 0) + 1);
    }
    return correctGroupOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, correctGroupOptions]);

  const filteredRows = useMemo(() => {
    if (correctGroupOptions.some((name) => correctGroupFilter[name] === false)) {
      return searchedRows.filter((row) => correctGroupFilter[row.correctGroup] !== false);
    }
    return searchedRows;
  }, [searchedRows, correctGroupFilter, correctGroupOptions]);

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
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : 0;
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
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#0A0C11]">
      <SettlementHeader
        icon={Shuffle}
        title="Transfer Queue"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />

      {/* px-4 md:px-[28px] + the inner mx-auto max-w-[1400px] wrapper (no
          padding of its own) copies Daily Txn Entry's own <main> classes
          and nesting order exactly (app/daily-txn-entry/page.tsx), matching
          Top Up (app/topup/page.tsx) — same container size/placement. No pt
          here (was pt-4 directly on main) — SettlementHeader's switcher row
          already owns that spacing (py-4, symmetric top/bottom around the
          pills). */}
      <main className="flex-1 flex flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col min-h-0">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            {/* Custom single-row flex layout (filter block -> search,
                flex-1 -> actions), matching Wallet Status's toolbar so the
                search bar actually extends to fill the remaining space —
                the old Toolbar/Toolbar.Left/Toolbar.Right split couldn't
                do that since Toolbar.Left never grew relative to
                Toolbar.Right. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-border px-[13px] py-[10px]">
              {loading ? (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[118px]" />
                </div>
              ) : (
                <div className="relative mr-[10px] shrink-0">
                  <button
                    type="button"
                    ref={correctGroupButtonRef}
                    onClick={() => setCorrectGroupMenuOpen((current) => !current)}
                    aria-label="Correct Group"
                    aria-haspopup="true"
                    aria-expanded={correctGroupMenuOpen}
                    className="inline-flex h-8 shrink-0 items-center gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out hover:border-[color:var(--ui-accent)] hover:bg-[color:var(--ui-accent-soft)] active:scale-[0.97] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5"
                  >
                    <Layers size={12} className="text-[#475569] dark:text-[#9CA3AF]" />
                    <span>Correct Group</span>
                    {anyCorrectGroupUnchecked && (
                      <span className="flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-[color:var(--ui-accent)] px-[3px] text-[9px] font-semibold text-white">
                        {selectedCorrectGroupCount}
                      </span>
                    )}
                    <ChevronDown
                      size={11}
                      className={`text-[#475569] transition-transform duration-150 ease-in-out dark:text-[#9CA3AF] ${correctGroupMenuOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <FilterDropdown
                    open={correctGroupMenuOpen}
                    onOpenChange={setCorrectGroupMenuOpen}
                    anchorRef={correctGroupButtonRef}
                    options={correctGroupFilterOptions}
                    selected={correctGroupFilter}
                    onChange={setCorrectGroupFilter}
                  />
                </div>
              )}

              <div className="flex h-8 flex-1 min-w-[200px] items-center gap-[6px] rounded-[10px] border border-border bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:bg-[#12151D]">
                {loading ? (
                  <div className="dt-skeleton h-[10px] w-32 rounded-md" />
                ) : (
                  <>
                    <Search size={13} className="shrink-0 text-muted-foreground" />
                    <input
                      aria-label="Search for anything"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[11px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                      placeholder="Search for anything"
                    />
                  </>
                )}
              </div>

              <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                {loading && <div className="dt-skeleton h-8 w-8 rounded-[10px]" />}
                {!loading && (
                  <button type="button" onClick={handleExport} aria-label="Export to Excel" title="Export to Excel" className={ICON_BUTTON}>
                    <Download size={13} />
                    <span className="hidden xl:inline">Export</span>
                  </button>
                )}
                {loading && <div className="dt-skeleton h-8 w-8 rounded-[10px]" />}
                {!loading && (
                  <div className="relative">
                    <button
                      type="button"
                      ref={columnsButtonRef}
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="sendmoney-transfer-queue-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={13} />
                    </button>
                    <ColumnsDropdown
                      id="sendmoney-transfer-queue-columns-popover"
                      open={columnsMenuOpen}
                      onOpenChange={setColumnsMenuOpen}
                      anchorRef={columnsButtonRef}
                      columns={columnDefs}
                      onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))}
                      onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
              {/* Overlay, not in-flow — centers on this outer (bounded,
                  non-scrolling) container instead of the table's own
                  horizontally-scrollable content width. */}
              {loading && <TableLoadingSpinner overlay />}
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-xs" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#0E1119] border-b border-[#E2E8F0] dark:border-[#262B38] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[38px]">
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        className={headerCellClasses(col.align)}>
                        {/* Header shimmers along with the body during
                            loading, per explicit instruction — reverses the
                            earlier "headers are never placeholders" spec. */}
                        {loading ? (
                          <div
                            className={`h-[10px] w-3/5 max-w-[58px] dt-skeleton rounded-md ${
                              col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''
                            }`}
                          />
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
                            className={`flex w-full items-center gap-1.5 transition hover:opacity-80 ${col.align === 'center' ? 'justify-center' : col.align === 'right' ? 'justify-end' : 'justify-start'}`}
                          >
                            {/* No flex-1 on the label — it stretched the
                                label's BOX to fill the column's real
                                (colgroup %) width, which is usually much
                                wider than the header text alone needs, so
                                the icon (pushed to the far edge by
                                justify-center/-end) ended up looking
                                stranded far from the word. Keeping every
                                piece at its natural size lets
                                justify-center/-start/-end position the
                                whole [spacer?, label, icon] group correctly
                                without any piece over-stretching. */}
                            {col.align === 'center' && (
                              // Mirrored INVISIBLE copy of the icon on the
                              // opposite side of the label — balances the
                              // group so the label itself lands on the
                              // true center (only needed for center; left/
                              // right already anchor correctly without it).
                              <span aria-hidden="true" className="invisible">
                                <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                              </span>
                            )}
                            <span className="min-w-0 truncate">{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    // Empty — the loading indicator is the overlay spinner
                    // on the outer container, not row content here.
                    null
                  ) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr
                      key={row.key}
                      className={`dt-row-stagger-in border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}
                      style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                    >
                      {visibleColumns.map((col) => renderCell(row, col.key, searchTerm))}
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
                  <TableLoadingSpinner minHeight={8 * 90} />
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => {
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
                      <div
                        key={row.key}
                        className="dt-row-stagger-in rounded-xl border border-border bg-white p-3.5 dark:bg-[#12151D]"
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                      >
                        {(showAgent || showBrand) && (
                          <div className="flex items-start justify-between gap-2">
                            {showAgent && <p className="min-w-0 truncate text-sm font-bold text-foreground">{highlightMatch(row.account, searchTerm)}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{highlightMatch(displayBrand(row.brand), searchTerm)}</span>}
                          </div>
                        )}

                        {showBalance && (
                          <div className={`flex items-baseline justify-between ${(showAgent || showBrand) ? 'mt-2.5' : ''}`}>
                            <span className="text-[10px] font-medium text-muted-foreground">Company Balance</span>
                            <span className={`text-lg font-bold tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {highlightMatch(displayNum(row.companyBalance), searchTerm)}
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
                                  <p className={`text-[11px] font-semibold tabular-nums ${className}`}>{highlightMatch(value, searchTerm)}</p>
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
                                <p className="text-[11px] text-muted-foreground">{highlightMatch(row.currentGroup, searchTerm)}</p>
                              </div>
                            )}
                            {showCorrectGroup && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Correct Group</p>
                                <p className="text-[11px] font-medium text-foreground">{highlightMatch(row.correctGroup, searchTerm)}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {showRemarks && row.remarks && (
                          <p className="mt-2 text-[10px] text-muted-foreground">{highlightMatch(row.remarks, searchTerm)}</p>
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
              <CompactTableFooter
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
        </div>
      </main>
    </div>
  );
}
