'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronUp, ChevronDown, ChevronsUpDown, Columns3, Download, ArrowLeftRight, RefreshCw, MoreVertical, Copy, Pencil, Eye, Trash2, Inbox, Hash, Banknote } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import SettlementSummary, { type SettlementKpiItem } from '@/app/components/SettlementSummary';
import Toolbar from '@/app/components/Toolbar';
import DataTable from '@/app/components/DataTable';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import RecordFormModal, { type RecordFormField } from '@/app/components/RecordFormModal';
import AddRecordDropdown from '@/app/components/AddRecordDropdown';
import BulkImportModal from '@/app/components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '@/app/components/BulkEditModal';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { rawVal, displayNum, parseAmount } from '@/app/lib/format';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';
import { isToday, isYesterday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';
import { SETTLEMENT_BRAND_OPTIONS, SENDMONEY_WALLET_OPTIONS, SETTLEMENT_REMARKS_SUGGESTIONS } from '@/app/lib/settlementOptions';
import { parseSendMoneyOpeningCsv } from '@/app/lib/sendMoneyOpening';

function matchOptionCaseInsensitive(value: string, options: string[]): string {
  return options.find((option) => option.toLowerCase() === value.toLowerCase()) ?? value;
}

// Ghost button: 36px height, 8px radius, subtle #E2E8F0 border, #F8FAFC
// hover fill — copied verbatim from Cashout Settlement's own toolbar button
// style (app/stlm/page.tsx), replacing this page's smaller icon-only
// compact buttons.
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-colors duration-150 ease-out hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// EmptyState's action button for the no-search-results state (ghost/outline
// style) — mirrors Cashout Settlement's own EMPTY_STATE_ACTION_BUTTON
// (app/stlm/page.tsx) exactly.
const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// The genuinely-no-data empty state's "Add Record" — filled accent, Send
// Money's own var(--product-accent) (this component doesn't portal, so the
// var resolves fine here, unlike the modals' own portal-scoping issue).
const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-[color:var(--product-accent)] px-4 text-[13px] font-medium text-white transition-colors hover:opacity-90';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

type SettlementKpiStats = {
  todayCount: number;
  todayAmount: number;
  yesterdayCount: number;
  yesterdayAmount: number;
};

const EMPTY_KPI_STATS: SettlementKpiStats = { todayCount: 0, todayAmount: 0, yesterdayCount: 0, yesterdayAmount: 0 };

// Wraps the matched portion of `text` in <mark> — case-insensitive, every
// occurrence. Copied verbatim from Cashout Settlement (app/stlm/page.tsx)
// so both pages' search-highlight behavior is identical.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-[#BFDBFE] text-inherit dark:bg-[rgba(37,99,235,0.4)]">{part}</mark>
    ) : (
      part
    )
  );
}

type StlmRow = {
  agentName: string;
  amount: string;
  remarks: string;
  date: string;
  wallet: string;
  brand: string;
  // Sequential index assigned once at fetch time — the row-selection
  // checkbox system's only stable identity, since nothing in the sheet
  // itself provides one. Survives sort/search/pagination (those only
  // reorder/filter/slice the same row objects, never rebuild them), so a
  // Set<number> of these stays correct across all three; only a real
  // refetch (new row objects) invalidates it, which is exactly when
  // selection should clear anyway. Matches Cashout Settlement's own
  // convention exactly.
  _id: number;
};

// Col M's gateway label ("MCW SSP GATEWAY" etc.) identifies which system
// processed the settlement, not the wallet's own brand — so unlike Cashout's
// mapBrand(), brand here is derived straight from the wallet name itself
// (e.g. "D-B2BD-DELTA073-NG" -> segment "B2BD" -> "B2"), same pattern as
// app/lib/sendMoneyOpening.ts.
const BRAND_CODES = [...CASHOUT_BRAND_CODES, 'SH'];
const BRAND_DISPLAY_LABELS: Record<string, string> = { SH: 'Sharing' };

function resolveBrandFromWalletName(walletName: string): string {
  const segment = (walletName.split('-')[1] ?? '').toUpperCase();
  const code = BRAND_CODES.find((c) => segment.startsWith(c));
  return code ?? '−';
}

function displayBrand(code: string): string {
  return BRAND_DISPLAY_LABELS[code] ?? code;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display-only reformat of the raw "M/D/YYYY" sheet value into "Jul 21,
// 2026" — copied verbatim from Cashout Settlement (app/stlm/page.tsx), so
// both pages' Date column reads identically. The raw string itself is
// still what isToday()/sorting/search key off of, this never touches the
// underlying data.
function formatDateDisplay(dateStr: string): string {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's.
const COLUMN_IDS = {
  BRAND: 'brand',
  AGENT_NAME: 'agentName',
  WALLET: 'wallet',
  AMOUNT: 'amount',
  REMARKS: 'remarks',
  DATE: 'date',
  ACTIONS: 'actions',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];
type SortColumn = '' | Exclude<ColumnKey, typeof COLUMN_IDS.ACTIONS>;

// Column model matches Cashout Settlement's ColumnDef shape (`key` kept
// instead of that page's `id` since every existing reference here already
// reads `col.key`). Actions is the one protected, non-hideable column,
// copied from Cashout's own convention.
type ColumnDef = {
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

// Alignment matches Cashout Settlement (app/stlm/page.tsx) exactly, by
// explicit instruction: text columns left, Amount/Date right, Remarks
// center, Actions center (Cashout's own established convention for all of
// these). Actions itself is copied from Cashout too — a row-level "Copy
// row" menu, not present here before.
const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.key, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneySettlementColumnVisibility';

const columns: { key: ColumnKey; label: string }[] = DEFAULT_COLUMNS.map((col) => ({ key: col.key, label: col.label }));

// Column width shifts, each ~N px worth of width (converted to percentage
// points at this table's typical rendered width) moved from one column to
// another, per explicit request. Send Money Settlement only — Cashout
// Settlement's own column widths are untouched.
//   Agent Name -> Wallet: 30px (2.3 points)
//   Agent Name -> Brand: 30px (2.3 points)
//   Remarks -> Amount: 40px (3.0 points)
//   Remarks -> Brand: 30px (2.3 points)
//   Remarks -> Date: 25px (1.9 points)
//   Date -> Remarks: 50px (3.8 points)
//   Date -> Remarks: 50px (3.8 points) again
//   Remarks -> Amount: 20px (1.5 points), Remarks -> Wallet: 20px (1.5 points)
//   Brand -> Actions: 30px (2.3 points) — real numbers (this split alone
//   can't fix the checkbox-column overflow — see the calc() reserved
//   directly on Brand's <col> width above for that part).
//   Brand -> Agent Name: 1.3 points, Wallet -> Agent Name: 1.3 points —
//   per explicit request, to reduce (not fully eliminate — see
//   TABLE_MIN_WIDTH_PX above) real Agent Name truncation at ordinary,
//   non-zoomed widths. Brand/Wallet both render as short fixed-content
//   badges (a 2-char code; NAGAD/ROCKET/UPAY/BKASH) with real slack at
//   their old share — Brand already has its own 90px hard floor via the
//   calc() above regardless of this reduction, and Wallet's badge only
//   ever needs ~90-110px, well under even its new, smaller share. At this
//   table's typical ~1309px rendered width (1440px viewport), Agent Name's
//   new 19% share gives ~217px of text space — enough for every real
//   Settlement wallet name measured live, including the single longest
//   outlier (23 chars, "D-J1BD-COLOMBO006-NAGAD", needs ~213px). Narrower
//   common widths (1366/1280px) still occasionally clip the longest 1-2
//   outliers — not fully eliminated, an accepted residual per explicit
//   direction to bump width rather than guarantee zero truncation via
//   scroll-at-normal-zoom.
const columnWidths: Record<ColumnKey, string> = {
  brand: '10.0%',
  agentName: '19.0%',
  wallet: '14.5%',
  amount: '18.5%',
  remarks: '18.4%',
  date: '11.3%',
  actions: '8.3%',
};

// Real Agent Name (wallet name) values were getting ellipsis-truncated
// ("D-B2BD-DELTA07…") at high browser zoom, since table-layout:fixed's %
// <col> widths keep shrinking with the container, with nothing to stop
// them. table-layout:fixed still distributes % widths exactly as before —
// a `min-width` on the <table> element itself is a plain box-model
// constraint that applies BEFORE that distribution, so every column's own
// floor comes along for free once the table can't shrink past this point,
// without needing a per-<col> override (which fixed layout ignores) or
// changing any column's own % share.
//
// The floor is 1024px — deliberately BELOW the table's own natural
// (unconstrained) width at every common desktop viewport tested live
// (1920/1440/1366/1280px all render naturally wider than this), so normal
// zoom is provably unchanged: this constraint is already satisfied without
// even engaging at any of those sizes. It only starts holding the table
// steady once the container shrinks past 1024px — genuine high zoom, not
// ordinary use — at which point the wrapping div's own overflow-x-auto
// (already relied on elsewhere for this exact fallback) picks up the
// difference as horizontal scroll instead of letting columns keep
// shrinking indefinitely. This does not guarantee zero truncation for the
// longest real names at every zoom level (a stricter floor sized for that
// was measured to require ~1335-1524px, which starts clipping into normal
// 1440px/1366px viewports too — rejected per explicit direction to favor
// "no change at normal zoom" over "zero truncation ever") — it guarantees
// truncation never gets WORSE than viewing at a comfortable 1024px-wide
// table, no matter how far zoom pushes the effective container below that.
const TABLE_MIN_WIDTH_PX = 1024;

// Typography/padding copied verbatim from Cashout Settlement's own
// headerCellClasses (app/stlm/page.tsx) — no flex/justify here, since
// overriding a <th>'s display away from table-cell would break the
// colgroup's table-fixed sizing (the alignment/justify logic instead lives
// on the inner sort button, same as this file's own pre-existing pattern).
function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-4') {
  return `group ${paddingCls} text-[14px] leading-[20px] font-semibold text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap text-${align}`;
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

// `brand` carries the raw code for the color lookup (before displayBrand's
// 'SH'->'Sharing' relabel) — `children` is the (possibly search-highlighted,
// display-relabeled) content, which can differ from the raw string.
function BrandBadge({ children, brand }: { children: React.ReactNode; brand: string }) {
  return (
    <span className={`inline-flex h-[28px] items-center rounded-[999px] border px-[10px] text-[12px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${brandBadgeClasses(brand)}`}>
      {children}
    </span>
  );
}

// Per-wallet tint map — each wallet's own real brand color (Nagad orange,
// Rocket purple, Bkash pink, Upay red), same light-bg/border/text pattern as
// BrandBadge's tint map. Unknown values fall back to the same neutral slate
// this badge used exclusively before.
const WALLET_BADGE_TINTS: Record<string, string> = {
  NAGAD: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-900/50',
  ROCKET: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  BKASH: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-900/50',
  UPAY: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/50',
};

function walletBadgeClasses(wallet: string): string {
  return WALLET_BADGE_TINTS[wallet.toUpperCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

// `wallet` carries the raw value for the color lookup — `children` is the
// (possibly search-highlighted) display content.
function WalletBadge({ children, wallet }: { children: React.ReactNode; wallet: string }) {
  return (
    <span className={`inline-flex h-[24px] items-center rounded-[999px] border px-2 py-1 text-[12px] font-medium transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletBadgeClasses(wallet)}`}>
      {children}
    </span>
  );
}

// Row actions menu (⋮) — copied from Cashout Settlement (app/stlm/page.tsx),
// adapted to this page's own data (no toProperCase/formatDateDisplay here —
// this page's wallet/date values are already used raw elsewhere). Edit opens
// the (UI-only, prototype) RecordFormModal via the onEdit callback lifted to
// the page; View Details/Delete are disabled placeholders for a future CRUD
// flow, per spec — not wired to anything yet.
function RowActionsCell({ row, onEdit }: { row: StlmRow; onEdit: (row: StlmRow) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const copyRow = () => {
    const text = [
      `Brand: ${displayBrand(row.brand)}`,
      `Agent Name: ${row.agentName}`,
      `Wallet: ${row.wallet}`,
      `Amount: ${displayNum(row.amount)}`,
      `Remarks: ${row.remarks}`,
      `Date: ${formatDateDisplay(row.date)}`,
    ].join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
    setOpen(false);
  };

  return (
    <span className="relative inline-flex" onClick={(event) => event.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        aria-label="Row actions"
        onClick={(event) => {
          event.stopPropagation();
          const rect = btnRef.current?.getBoundingClientRect();
          if (rect) setPos({ top: rect.bottom + 4, left: rect.right - 144 });
          setOpen((current) => !current);
        }}
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#94A3B8] transition-colors duration-150 hover:bg-[#F1F5F9] hover:text-[#475569] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:hover:bg-white/5"
      >
        <MoreVertical size={16} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="z-[9999] w-36 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { setOpen(false); onEdit(row); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Pencil size={13} />
            Edit
          </button>
          <button
            type="button"
            onClick={copyRow}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Copy size={13} />
            Copy row
          </button>
          <div className="my-1 border-t border-[#F1F5F9] dark:border-[#2f2f32]" />
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]"
          >
            <Eye size={13} />
            View Details
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]"
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>,
        document.body
      )}
    </span>
  );
}

// Copied verbatim from Cashout Settlement (app/stlm/page.tsx) — size,
// always-visible behavior, and colors all match exactly. This replaces the
// prior hover-only-reveal, teal-accented pattern.
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

// Typography/padding/truncation copied verbatim from Cashout Settlement's
// own renderCell (app/stlm/page.tsx): only Agent Name/Remarks truncate,
// text-[13px]/leading-[20px]/font-normal/hardcoded body colors, Amount gets
// its own smaller-bold !text-[12px] font-semibold. Brand/Wallet keep this
// page's own data functions (displayBrand, raw wallet) but now render
// inside Cashout's exact badge components instead of plain text.
function renderCell(row: StlmRow, key: ColumnKey, onEdit: (row: StlmRow) => void, searchTerm: string) {
  const truncates = key === COLUMN_IDS.AGENT_NAME || key === COLUMN_IDS.REMARKS;
  // Body content centers on the column's true geometric center, full stop —
  // the header's trailing sort icon is NOT factored in here. Amount is now
  // center-aligned like Wallet/Remarks (was right-aligned with its own
  // pl-4 pr-28 breathing-room padding) — plain px-4 for every column.
  const cellCls = `whitespace-nowrap ${truncates ? 'overflow-hidden text-ellipsis' : ''} px-4 text-${COLUMN_ALIGN[key]} text-[13px] leading-[20px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  const base = `${cellCls} py-[14px]`;
  switch (key) {
    case 'brand':
      // py-3 (not the shared py-[14px]) — a real <tr>'s height is a floor,
      // not a cap like Cashout's own Flex row, so the 28px badge + full
      // padding would grow the row past 52px; py-3 lands it exactly there.
      return <td key={key} className={`${cellCls} py-3`}><BrandBadge brand={row.brand}>{highlightMatch(displayBrand(row.brand), searchTerm)}</BrandBadge></td>;
    case 'agentName':
      return <td key={key} title={row.agentName} className={base}>{highlightMatch(row.agentName, searchTerm)}</td>;
    case 'wallet':
      return <td key={key} className={base}><WalletBadge wallet={row.wallet}>{highlightMatch(row.wallet, searchTerm)}</WalletBadge></td>;
    case 'amount':
      return <td key={key} className={`${base} !text-[12px] font-semibold tabular-nums`}>{highlightMatch(displayNum(row.amount), searchTerm)}</td>;
    case 'remarks':
      return <td key={key} title={row.remarks} className={base}>{highlightMatch(row.remarks, searchTerm)}</td>;
    case 'date':
      return <td key={key} className={base}>{highlightMatch(formatDateDisplay(row.date), searchTerm)}</td>;
    case 'actions':
      // Flex goes on an inner span, not the <td> itself — overriding a real
      // table cell's own display away from table-cell risks breaking the
      // colgroup's table-fixed column sizing. py-2.5 (not the shared
      // py-[14px]) — same reason as Brand's own override: a real <tr>'s
      // height is a floor, not a cap, so the 32px action button + full
      // padding would grow the row past 52px; py-2.5 (10px) lands it
      // exactly there (32 + 10 + 10 = 52).
      return <td key={key} className={`${cellCls} py-2.5`}><span className="flex items-center justify-center"><RowActionsCell row={row} onEdit={onEdit} /></span></td>;
    default:
      return null;
  }
}

// Widths chosen from measuring the REAL rendered table (Puppeteer, Range-
// based text-width against each cell's own box), not guessed — see Cashout
// Settlement's own skeleton (app/stlm/page.tsx) for the full measurement
// notes. Matches Cashout's values exactly except Date, which uses this
// page's own shorter "7/23/2026" format (~45%, vs Cashout's "Jul 23, 2026"
// at ~50%) — the two pages' Date columns render genuinely different text
// lengths, so their skeleton widths shouldn't be forced to match.
const AGENT_NAME_SKELETON_WIDTHS = [55, 70, 85];
const REMARKS_SKELETON_WIDTHS = [50, 65, 80];
const AMOUNT_SKELETON_WIDTHS = [26, 30, 24, 28];
const WALLET_SKELETON_WIDTHS = [48, 60, 52, 56];

// Skeleton mirrors renderCell's own shapes per column (badge → pill, pill
// → pill, number/date → short right-aligned bar) instead of one generic bar
// repeated across every column, so the loading state reads as a blurred
// version of the real table rather than a placeholder grid. Header labels
// are NEVER part of this — only body/data cells shimmer.
function renderSkeletonCell(col: ColumnDef, rowIndex: number) {
  switch (col.key) {
    case 'brand':
      // Pill (h-[28px] w-9 rounded-full), not a circle — matches the real
      // BrandBadge's own height exactly and its typical rendered width
      // (measured ~35-38px for real 2-char codes). py-3 (not py-[14px]) —
      // matches renderCell's real Brand cell: a real <tr>'s height is a
      // floor, not a cap, so the 28px badge + full padding would grow the
      // row past 52px.
      return (
        <td key={col.key} className="px-4 py-3">
          <div className="dt-skeleton h-[28px] w-9 rounded-full" />
        </td>
      );
    case 'agentName':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${AGENT_NAME_SKELETON_WIDTHS[rowIndex % AGENT_NAME_SKELETON_WIDTHS.length]}%` }}
          />
        </td>
      );
    case 'wallet':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div
            className="dt-skeleton h-6 rounded-full mx-auto"
            style={{ width: WALLET_SKELETON_WIDTHS[rowIndex % WALLET_SKELETON_WIDTHS.length] }}
          />
        </td>
      );
    case 'amount':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div className="dt-skeleton h-3 rounded-md mx-auto" style={{ width: `${AMOUNT_SKELETON_WIDTHS[rowIndex % AMOUNT_SKELETON_WIDTHS.length]}%` }} />
        </td>
      );
    case 'remarks':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${REMARKS_SKELETON_WIDTHS[rowIndex % REMARKS_SKELETON_WIDTHS.length]}%` }}
          />
        </td>
      );
    case 'date':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div className="dt-skeleton h-3 rounded-md ml-auto" style={{ width: '45%' }} />
        </td>
      );
    case 'actions':
      // h-8 w-8 rounded-[8px] — matches RowActionsCell's real button
      // exactly. py-2.5 (not py-[14px]) for the same row-height-floor
      // reason as the real Actions cell.
      return (
        <td key={col.key} className="px-4 py-2.5">
          <div className="dt-skeleton h-8 w-8 rounded-[8px] mx-auto" />
        </td>
      );
    default:
      return null;
  }
}

export default function SendMoneySettlementPage() {
  const [stlmRows, setStlmRows] = useState<StlmRow[]>([]);
  // The real Balance Shop Agent roster — sourced from Opening AG cols L:O
  // (same data /sendmoney/opening reads), not from today's Settlement rows.
  // Settlement only ever sees agents who already had a transaction today;
  // Opening has the full ~9,983-row roster, so a brand-new/rarely-active
  // agent still resolves correctly here.
  const [openingAgentNames, setOpeningAgentNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  // SettlementSummary's KPI row — real counts/totals computed in fetchData
  // from the SAME "PS BD STLM + TOPUP" sheet the table itself reads (it
  // carries several weeks of rows, not just today's; isToday()/isYesterday()
  // narrow it down). Not derived from stlmRows itself, since that's already
  // narrowed to today only — see fetchData for the actual computation.
  const [kpiStats, setKpiStats] = useState<SettlementKpiStats>(EMPTY_KPI_STATS);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsMenuPos, setColumnsMenuPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  // Row Actions -> Edit (UI-only prototype, no persistence — see
  // RecordFormModal). Holds the row being edited; null means the modal is
  // closed.
  const [editingRow, setEditingRow] = useState<StlmRow | null>(null);
  // "+ Add" dropdown -> New Record / Bulk Import (both UI-only prototypes,
  // same precedent as Edit above — see RecordFormModal/BulkImportModal).
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  // Checkbox row selection (keyed by StlmRow._id, see its own comment) —
  // persists across sort/search/pagination by design; only cleared by
  // Clear Selection or a fresh fetchData (see there). Reusable base for
  // any future bulk action beyond Bulk Edit (Delete Selected, Export
  // Selected, etc.) — nothing about this state is Bulk-Edit-specific.
  // Matches Cashout Settlement's own convention exactly.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // Mirrors `selectedIds.size > 0` — swaps the toolbar between the "{N}
  // Selected"/Bulk Edit cluster and the Add button.
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  // Sticky-header scroll shadow — copied from Cashout Settlement's
  // DataTable.StickyHeader (app/components/DataTable.tsx): the shadow only
  // appears once real content has scrolled underneath the header.
  const [isScrolled, setIsScrolled] = useState(false);
  const [atScrollStart, setAtScrollStart] = useState(true);
  const [atScrollEnd, setAtScrollEnd] = useState(true);
  const tableScrollRef = useRef<HTMLDivElement>(null);

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

      const [res, openingRes] = await Promise.all([
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/sendmoney/opening?t=${Date.now()}`),
      ]);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);

      // Agent Name roster — same "Opening AG" L:O range /sendmoney/opening
      // reads, the real Balance Shop master list rather than a today-only
      // stand-in.
      if (openingRes.ok) {
        const openingText = await openingRes.text();
        // Uppercased before dedup — the real table always displays Agent
        // Name via .toUpperCase(), so the roster feeding Add/Edit's
        // combobox and Bulk Import's validation should match that same
        // canonical casing regardless of how the sheet itself has it stored.
        const openingNames = Array.from(new Set(parseSendMoneyOpeningCsv(openingText).map((row) => row.agentName.toUpperCase()))).sort((a, b) => a.localeCompare(b));
        setOpeningAgentNames(openingNames);
      }

      const stlm: StlmRow[] = [];

      // "PS BD STLM + TOPUP" is Send Money's own dedicated sheet (replaces
      // the old shared "Stlm Top Up" cols A-G source). Settlement lives in
      // cols H-L (indices 7-11): To Agent/Amount/Date/Wallet/TYPE. To Agent
      // (col H) is the actual Send Money wallet name (e.g.
      // "D-B2BD-DELTA073-NG"); Amount (col I) is stored negative (money
      // leaving), so it's abs()'d for display; TYPE (col L, e.g. "BUNDLE
      // TRANSFER") stands in for Remarks, same as before. Cols B-F on this
      // same sheet are a separate TopUp block (see /sendmoney/topup) and
      // cols Q-AA are a last-month archive — neither belongs here.
      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const walletName = rawVal(cols[7]);
          if (walletName && walletName !== '-' && walletName !== '0') {
            stlm.push({
              agentName: walletName,
              amount: String(Math.abs(parseAmount(rawVal(cols[8])))),
              remarks: rawVal(cols[11]),
              date: rawVal(cols[9]),
              wallet: rawVal(cols[10]),
              brand: resolveBrandFromWalletName(walletName),
              _id: stlm.length,
            });
          }
        });

      // Same validity filter as before, split out so both the table's
      // "today only" rows and the KPI row's "today vs yesterday" comparison
      // can be computed from one pass over the full (unfiltered-by-date)
      // sheet, instead of the table's own isToday() filter discarding
      // yesterday's rows before the KPI row ever gets a chance to see them.
      const validStlm = stlm.filter(row => row.agentName && row.agentName !== '-' && row.agentName !== '0');
      const todayStlm = validStlm.filter(row => isToday(row.date));
      const yesterdayStlm = validStlm.filter(row => isYesterday(row.date));

      setStlmRows(todayStlm);
      // A fresh fetch means brand-new row objects (and _ids reset to 0..N)
      // — any previous selection no longer refers to anything real, so it
      // clears here rather than silently pointing at the wrong rows.
      setSelectedIds(new Set());
      setKpiStats({
        todayCount: todayStlm.length,
        todayAmount: todayStlm.reduce((sum, row) => sum + parseAmount(row.amount), 0),
        yesterdayCount: yesterdayStlm.length,
        yesterdayAmount: yesterdayStlm.reduce((sum, row) => sum + parseAmount(row.amount), 0),
      });
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

  const searchedRows = stlmRows.filter((row) => {
    const haystack = `${row.agentName} ${row.amount} ${row.remarks} ${row.date} ${row.wallet} ${row.brand}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const sortedRows = useMemo(() => {
    if (!sortColumn) return searchedRows;
    const list = [...searchedRows];
    list.sort((a, b) => {
      const getValue = (row: StlmRow) => {
        switch (sortColumn) {
          case 'brand':
            return displayBrand(row.brand).toLowerCase();
          case 'agentName':
            return row.agentName.toLowerCase();
          case 'wallet':
            return row.wallet.toLowerCase();
          case 'amount':
            return parseAmount(row.amount);
          case 'remarks':
            return row.remarks.toLowerCase();
          case 'date':
            return row.date.toLowerCase();
          default:
            return '';
        }
      };

      const valueA = getValue(a);
      const valueB = getValue(b);

      if (typeof valueA === 'string' || typeof valueB === 'string') {
        const comparison = String(valueA).localeCompare(String(valueB));
        return sortDirection === 'asc' ? comparison : -comparison;
      }

      const comparison = (valueA as number) - (valueB as number);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [searchedRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  // Header checkbox only ever acts on the CURRENT page's rows (per spec),
  // even though selectedIds itself can hold ids from other pages too.
  const pageRowIds = pagedRows.map((row) => row._id);
  const selectedOnPageCount = pageRowIds.filter((id) => selectedIds.has(id)).length;
  const allOnPageSelected = pageRowIds.length > 0 && selectedOnPageCount === pageRowIds.length;

  // Swaps back to the Add button the instant selectedIds hits 0 — no exit
  // delay. An earlier version held the "{N} Selected"/Bulk Edit cluster
  // rendered for 150ms after reaching 0 so its own fade-out could play, but
  // that read as a stale "0 Selected" catching the user's eye right after
  // they'd already cleared the selection — worse than an instant swap.
  useEffect(() => {
    setSelectionBarRendered(selectedIds.size > 0);
  }, [selectedIds.size]);

  const toggleRowSelection = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllOnPage = useCallback(() => {
    if (allOnPageSelected) {
      // Same fast full reset the old "Clear Selection" button used — a
      // plain setSelectedIds(new Set()), instead of copying the existing
      // Set and deleting this page's ids out of it one by one, which is
      // what made unchecking via the header checkbox feel noticeably
      // slower (a visible "0 Selected" lag) than the button was.
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      pageRowIds.forEach((id) => next.add(id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allOnPageSelected, pageRowIds.join(',')]);

  // Reverses DateInput's own "Jul 24, 2026" display format back into this
  // page's raw "M/D/YYYY" row storage convention — mirrors the same
  // conversion BulkImportModal's Edit Row dialog already does.
  const parseDisplayDateToStorage = (display: string): string => {
    const parsed = new Date(display);
    if (isNaN(parsed.getTime())) return display;
    return `${parsed.getMonth() + 1}/${parsed.getDate()}/${parsed.getFullYear()}`;
  };

  const handleBulkEditApply = useCallback((updates: BulkEditUpdates) => {
    setStlmRows((current) => current.map((row) => {
      if (!selectedIds.has(row._id)) return row;
      return {
        ...row,
        ...(updates.wallet !== undefined ? { wallet: updates.wallet } : {}),
        ...(updates.remarks !== undefined ? { remarks: updates.remarks } : {}),
        ...(updates.date !== undefined ? { date: parseDisplayDateToStorage(updates.date) } : {}),
      };
    }));
    setBulkEditOpen(false);
    setSelectedIds(new Set());
  }, [selectedIds]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const settlementRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: SETTLEMENT_BRAND_OPTIONS, required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: openingAgentNames, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: SENDMONEY_WALLET_OPTIONS, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'remarks', label: 'Remarks', kind: 'combobox', options: SETTLEMENT_REMARKS_SUGGESTIONS, allowCustom: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [openingAgentNames]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: StlmRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return displayBrand(row.brand);
        case 'agentName':
          return row.agentName;
        case 'wallet':
          return row.wallet;
        case 'amount':
          return displayNum(row.amount);
        case 'remarks':
          return row.remarks;
        case 'date':
          return row.date;
        default:
          return '';
      }
    };

    const exportColumns = visibleColumns.filter((col) => col.key !== COLUMN_IDS.ACTIONS);
    const headers = exportColumns.map((col) => col.label);
    const data = sortedRows.map((row) => exportColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Settlement');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_SETTLEMENT_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  // Clears the free-text search — matches Cashout Settlement's own "Clear
  // Search" behavior exactly.
  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Genuinely-no-data vs a search/filter that returns nothing — same
  // distinction and copy as Cashout Settlement (app/stlm/page.tsx), keyed
  // off stlmRows (the unfiltered set) so an active search returning zero
  // rows out of a real dataset is never mistaken for "no records exist."
  const kpiItems: SettlementKpiItem[] = useMemo(() => [
    { icon: Hash, label: "Today's Total Count", value: kpiStats.todayCount.toLocaleString('en-US') },
    { icon: Banknote, label: "Today's Total Amount", value: displayNum(kpiStats.todayAmount) },
    { icon: Hash, label: "Yesterday's Total Count", value: kpiStats.yesterdayCount.toLocaleString('en-US') },
    { icon: Banknote, label: "Yesterday's Total Amount", value: displayNum(kpiStats.yesterdayAmount) },
  ], [kpiStats]);

  const hasAnyRecords = stlmRows.length > 0;
  const emptyStateNode = !hasAnyRecords ? (
    <EmptyState
      icon={Inbox}
      title="No Settlement Records"
      description="Settlement records will appear here once they are created or imported."
      action={
        <button type="button" onClick={() => setNewRecordOpen(true)} className={EMPTY_STATE_PRIMARY_BUTTON}>
          Add Record
        </button>
      }
    />
  ) : (
    <EmptyState
      title="No matching settlement records."
      description="Try changing your search or filters."
      action={
        <button type="button" onClick={clearSearch} className={EMPTY_STATE_ACTION_BUTTON}>
          Clear Search
        </button>
      }
    />
  );

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <SettlementHeader
        icon={ArrowLeftRight}
        title="Settlement"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />
      <SettlementSummary items={kpiItems} isScrolled={isScrolled} loading={loading} />

      {/* pt-4 (16px) instead of the uniform p-6's 24px top — explicit
          breathing room between SettlementSummary and the toolbar below,
          tuned to spec (12-16px) rather than left at the larger default. */}
      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-1">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            <Toolbar>
              <Toolbar.Left>
                {/* Records pill removed — not present on Cashout Settlement.
                    Search bar sizing (height/width/padding/radius/icon/font)
                    copied verbatim from Cashout Settlement (app/stlm/page.tsx). */}
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
                {loading && <div className="dt-skeleton h-9 w-[76px] rounded-[8px]" />}
                {!loading && (
                  selectionBarRendered ? (
                    <div className="flex flex-wrap items-center gap-3 dt-bar-fade-in">
                      <span className="text-[13px] font-medium text-foreground">{selectedIds.size} Selected</span>
                      <button
                        type="button"
                        onClick={() => setBulkEditOpen(true)}
                        className="inline-flex h-9 items-center rounded-[8px] bg-[color:var(--product-accent)] px-3 text-[13px] font-medium text-white transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                      >
                        Bulk Edit
                      </button>
                    </div>
                  ) : (
                    <AddRecordDropdown
                      templateModule="settlement"
                      onNewRecord={() => setNewRecordOpen(true)}
                      onBulkImport={() => setBulkImportOpen(true)}
                      buttonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
                    />
                  )
                )}
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
                      aria-controls="sendmoney-settlement-columns-popover"
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
                        id="sendmoney-settlement-columns-popover"
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
                              <span>{col.label}</span>
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
            {/* 6px breathing room above the table's sticky column header —
                page-local spacer, not a change to Toolbar's own shared
                internals. Desktop only, matching the table header this is
                separating from; the mobile card list below has no such
                header to separate from. */}
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
            <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-sm" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  <col style={{ width: '44px' }} />
                  {/* Every column's width is a % of the table, so they
                      always sum to exactly 100% no matter how columnWidths
                      is split between them — shuffling numbers between
                      Brand and Actions can't change that total. The 44px
                      checkbox <col> above is a separate fixed-width column
                      outside this whole percentage system, so without this
                      it always overflows the table by its own 44px
                      regardless of Brand/Actions' relative sizes. Reserving
                      that 44px directly out of Brand's own width via
                      calc() — not a shared/hidden total — is what actually,
                      exactly (at any table width, not just one reference
                      size) removes the horizontal scroll.

                      Browser zoom shrinks the table's *effective* CSS px
                      width the same way a narrower viewport would, so the
                      % above shrinks too — at 150%+ zoom the calc() alone
                      could compute below Brand's own real badge width
                      (reported live: the Brand pill visibly clipped to a
                      single clipped letter). max(90px, ...) puts a hard
                      floor under it — past that floor the table overflows
                      instead and the wrapping div's own overflow-x-auto
                      picks it up as horizontal scroll, the correct
                      fallback at extreme zoom. */}
                  {visibleColumns.map((col) => (
                    <col
                      key={col.key}
                      style={{ width: col.key === COLUMN_IDS.BRAND ? `max(90px, calc(${columnWidths[col.key]} - 44px))` : columnWidths[col.key] }}
                    />
                  ))}
                </colgroup>
                <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[48px]">
                    <th style={{ width: '44px' }} className="px-0">
                      <div className="flex items-center justify-center">
                        <input
                          type="checkbox"
                          aria-label="Select all rows on this page"
                          checked={allOnPageSelected}
                          onChange={toggleSelectAllOnPage}
                          className="h-3.5 w-3.5 cursor-pointer"
                        />
                      </div>
                    </th>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: columnWidths[col.key] }}
                        className={headerCellClasses(col.align, 'px-4')}>
                        {/* Header always renders its real label/sort control,
                            loading or not — only data rows shimmer (premium
                            skeleton spec: headers are never placeholders). */}
                        {!col.sortable ? (
                          <span>{col.label}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              if (sortColumn === col.key) {
                                setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortColumn(col.key as SortColumn);
                                setSortDirection('asc');
                              }
                            }}
                            className={`relative flex w-full items-center gap-1.5 text-${col.align} transition hover:opacity-80 ${
                              col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : 'justify-start'
                            }`}
                          >
                            {col.align === 'center' ? (
                              <span className="relative inline-flex items-center">
                                {col.label}
                                <span className="absolute left-full ml-1.5 flex items-center">
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              </span>
                            ) : (
                              <>
                                <span>{col.label}</span>
                                <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                              </>
                            )}
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? Array.from({ length: 11 }).map((_, i) => (
                    <tr key={i} className="h-[52px] border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32]">
                      <td />
                      {visibleColumns.map((col) => renderSkeletonCell(col, i))}
                    </tr>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    // Row height (h-[52px]), border color (border-[#ECEFF3]/
                    // dark:border-[#2f2f32]), and hover fill (hover:bg-black/
                    // [0.02]) copied verbatim from Cashout Settlement's own
                    // body row.
                    const isChecked = selectedIds.has(row._id);
                    return (
                      <tr
                        key={i}
                        tabIndex={0}
                        onClick={() => toggleRowSelection(row._id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleRowSelection(row._id);
                          }
                        }}
                        aria-selected={isChecked}
                        className={`h-[52px] cursor-pointer border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32] transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB] ${
                          isChecked
                            ? 'bg-[color:var(--product-accent-soft)]'
                            : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.025]'
                        }`}
                      >
                        <td onClick={(event) => event.stopPropagation()}>
                          <div className="flex items-center justify-center">
                            <input
                              type="checkbox"
                              aria-label={`Select row for ${row.agentName}`}
                              checked={isChecked}
                              onChange={() => toggleRowSelection(row._id)}
                              className="h-3.5 w-3.5 cursor-pointer"
                            />
                          </div>
                        </td>
                        {visibleColumns.map((col) => renderCell(row, col.key, setEditingRow, searchTerm))}
                      </tr>
                    );
                  }) : !loading && (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)}>
                        {emptyStateNode}
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
                  pagedRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{displayBrand(row.brand)} · {row.wallet}</p>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{formatDateDisplay(row.date)}</span>
                      </div>

                      <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
                        <span className="text-[10px] font-medium text-muted-foreground">{row.remarks}</span>
                        <span className="text-lg font-bold tabular-nums text-foreground">{displayNum(row.amount)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  emptyStateNode
                )}
              </div>
            </div>

            {!loading && (
              <TableFooter
                recordCountText={
                  sortedRows.length === 0
                    ? 'Showing 0 of 0 Records'
                    : `Showing ${startIndex + 1}–${Math.min(endIndex, sortedRows.length)} of ${sortedRows.length} Records`
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

      <RecordFormModal
        isOpen={editingRow !== null}
        onClose={() => setEditingRow(null)}
        title="Edit Settlement Record"
        fields={settlementRecordFields}
        initialValues={editingRow ? {
          brand: matchOptionCaseInsensitive(editingRow.brand, SETTLEMENT_BRAND_OPTIONS),
          // Uppercase — Agent Name's canonical form is full caps, regardless
          // of how the sheet itself has it stored.
          agentName: editingRow.agentName.toUpperCase(),
          wallet: matchOptionCaseInsensitive(editingRow.wallet, SENDMONEY_WALLET_OPTIONS),
          amount: String(parseAmount(editingRow.amount)),
          remarks: editingRow.remarks,
          date: formatDateDisplay(editingRow.date),
        } : {}}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        title="New Settlement Record"
        fields={settlementRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        moduleLabel="Settlement Records"
        templateModule="settlement"
        accentButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
        brandOptions={SETTLEMENT_BRAND_OPTIONS}
        walletOptions={SENDMONEY_WALLET_OPTIONS}
        agentRoster={openingAgentNames}
        remarksSuggestions={SETTLEMENT_REMARKS_SUGGESTIONS}
      />

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        walletOptions={SENDMONEY_WALLET_OPTIONS}
        remarksSuggestions={SETTLEMENT_REMARKS_SUGGESTIONS}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />
    </div>
  );
}
