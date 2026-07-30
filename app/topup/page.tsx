'use client';

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Download,
  PlusCircle,
  RefreshCw,
  MoreVertical,
  Copy,
  Columns3,
  Pencil,
  Eye,
  Trash2,
  Inbox,
  Hash,
  Banknote,
  Tag,
  User,
  Wallet as WalletIcon,
  FilterX,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import TableFooter from '../components/TableFooter';
import FilterDropdown from '../components/FilterDropdown';
import ColumnsDropdown from '../components/ColumnsDropdown';
import EmptyState from '../components/EmptyState';
import DataTable from '../components/DataTable';
import RecordFormModal, { type RecordFormField } from '../components/RecordFormModal';
import { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, TOPUP_TYPE_OPTIONS } from '../lib/topupOptions';
import AddRecordDropdown from '../components/AddRecordDropdown';
import BulkImportModal from '../components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '../components/BulkEditModal';
import { classifyFetchError, type ClassifiedError } from '../lib/errors';
import { rawVal, displayNum, parseAmount, fmt, fmtAbbrev } from '@/app/lib/format';
import { isToday, isYesterday } from '../lib/businessDate';
import { getPreference, setPreference } from '../lib/preferences';
import { calculateColumnLayout, type ColumnLayout } from '../lib/columnLayout';

// Responsive action buttons (Refresh/Export/Columns) — icon+text when the
// viewport has room, collapsing to icon-only (40x40, no padding) once space
// gets tight. Copied verbatim from Balance (app/agentbal/page.tsx) so this
// page's toolbar matches its style/arrangement exactly, per explicit
// instruction.
const ICON_BUTTON =
  'flex h-10 w-10 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-1.5 rounded-[12px] border border-[#E2E8F0] bg-white px-0 xl:px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Shared hover/focus-driven tooltip state — portal-rendered so it's never
// clipped by the toolbar's overflow-x-auto. Copied verbatim from Balance
// (app/agentbal/page.tsx) — page-local by established project convention.
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

// Dark, arrow-tipped, fade-in tooltip — same visual language as every
// toolbar button. `onlyWhenCompact` hides it once the button's own text
// label is visible (xl: breakpoint), showing it again only in icon-only mode.
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

// Toolbar filter trigger — Brand/Leader/Wallet. Trigger only; the panel
// beneath it is the shared FilterDropdown (app/components/FilterDropdown.tsx).
// Copied verbatim from Balance.
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
        className="inline-flex h-10 w-10 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-1.5 rounded-[12px] border border-[#E2E8F0] bg-white px-0 xl:px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5"
      >
        <Icon size={15} className="text-[#475569] dark:text-[#9CA3AF]" />
        <span className="hidden xl:inline">{label}</span>
        {anyUnchecked && (
          <span className="flex h-4 min-w-[16px] animate-[dt-badge-pop_150ms_var(--ease-out-strong)] items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
            {selectedCount}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`hidden text-[#475569] transition-transform duration-150 ease-[var(--ease-in-out-strong)] dark:text-[#9CA3AF] xl:inline ${menuOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {tooltip.rendered && <Tooltip label={label} open={tooltip.open} pos={tooltip.pos} onlyWhenCompact />}
    </div>
  );
}

// "Reset All Filters" trigger — filled indigo icon once a filter is active.
// Copied verbatim from Balance.
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
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out-strong)] ${
          anyFilterActive
            ? 'cursor-pointer border-[#E2E8F0] bg-white text-indigo-600 hover:border-[#FCA5A5] hover:bg-[#FEF2F2] hover:text-[#DC2626] active:scale-[0.97] active:border-[#FCA5A5] active:bg-[#FEF2F2] active:text-[#DC2626] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-indigo-400'
            : 'cursor-default border-[#E2E8F0] bg-white text-[#475569] opacity-40 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]'
        }`}
      >
        <FilterX size={20} fill={anyFilterActive ? 'currentColor' : 'none'} />
      </button>
      {tooltip.rendered && <Tooltip label="Reset all filters" open={tooltip.open} pos={tooltip.pos} />}
    </div>
  );
}

const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-indigo-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

type TopUpKpiStats = {
  todayCount: number;
  todayAmount: number;
  yesterdayCount: number;
  yesterdayAmount: number;
};

const EMPTY_KPI_STATS: TopUpKpiStats = { todayCount: 0, todayAmount: 0, yesterdayCount: 0, yesterdayAmount: 0 };

// Wraps the matched portion of `text` in <mark> — case-insensitive, every
// occurrence. Copied verbatim from Settlement (app/stlm/page.tsx) so search
// highlighting behaves identically here.
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

type TopUpRow = {
  agentName: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
  leader: string;
  brand: string;
  // Sequential index assigned once at fetch time — the row-selection
  // checkbox system's only stable identity, same convention as Settlement's
  // StlmRow._id (app/stlm/page.tsx).
  _id: number;
};

// "AG BD STLM + TOPUP" no longer carries a brand/gateway column (removed from
// the sheet). Brand now comes first from the "-<brand>" suffix already
// displayed on the shop/agent name itself (e.g. "KONAN001-M1" → M1) when
// present; only when a row's shop name has no suffix (e.g. "YUJI024") does
// it fall back to cross-referencing the bare agent code against "SSP AG
// BalanceLimit" (same Group data and priority logic Cashout's own Agent
// Balance page already uses). Unchanged from before this rewrite — data
// logic, not presentation.
const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
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

const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−') return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

// "To Agent" values sometimes carry a trailing "-<brand>" suffix (e.g.
// "KONAN001-M1"), sometimes not (e.g. "YUJI024") — strip it so the bare
// code matches "SSP AG BalanceLimit"'s own (always-bare) wallet names. Some
// rows now carry the suffix twice (e.g. "KONAN001-M1-M1", "SUPER001-M2-B4")
// so this strips every recognized trailing segment in a loop, not just one.
function stripBrandSuffix(name: string): string {
  let result = name;
  let parts = result.split('-');
  while (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    result = parts.slice(0, -1).join('-');
    parts = result.split('-');
  }
  return result;
}

// Same suffix this strips off for the lookup key — but here it's the brand
// source itself, read directly off the shop name as displayed. Returns null
// when the shop name carries no suffix, so the caller can fall back to the
// cross-reference lookup.
function extractBrandSuffix(name: string): string | null {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  return parts.length >= 2 && BRAND_CODES.includes(last) ? last : null;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display-only reformat of the raw "M/D/YYYY" sheet value into "Jul 21,
// 2026" — copied verbatim from Settlement's formatDateDisplay.
function formatDateDisplay(dateStr: string): string {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx; Top Up gets its own COLUMN_IDS (it has a Leader column
// Settlement doesn't, and no Remarks column).
const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  AGENT_NAME: 'agentName',
  WALLET: 'wallet',
  AMOUNT: 'amount',
  TYPE: 'type',
  DATE: 'date',
  ACTIONS: 'actions',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];
type SortColumn = '' | Exclude<ColumnKey, typeof COLUMN_IDS.ACTIONS>;

type ColumnDef = {
  id: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
  minWidth: number;
  preferredWidth: number;
  grow: number;
};

// Column sizing now matches Settlement's own arrangement exactly
// (app/stlm/page.tsx's DEFAULT_COLUMNS + toFlexColumnStyle) — by explicit
// instruction, Top Up and Settlement share the same 8 columns (Brand/
// Leader/Agent Name/Wallet/Amount/Type/Date/Action, Type being Settlement's
// own Remarks-turned-Type column) and should render with the same
// proportions. minWidth/preferredWidth values below are copied verbatim
// from Settlement.
const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left', minWidth: 90, preferredWidth: 149, grow: 0 },
  { id: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left', minWidth: 100, preferredWidth: 150, grow: 1 },
  { id: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left', minWidth: 140, preferredWidth: 216, grow: 1 },
  { id: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 90, preferredWidth: 208, grow: 0 },
  { id: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 115, preferredWidth: 244, grow: 0 },
  { id: COLUMN_IDS.TYPE, label: 'Type', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 160, preferredWidth: 243, grow: 1 },
  { id: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'right', minWidth: 110, preferredWidth: 149, grow: 0 },
  { id: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center', minWidth: 56, preferredWidth: 109, grow: 0 },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'topUpColumnVisibility';

// Adaptive Column Width Distribution — same Flex translation as Settlement
// (app/stlm/page.tsx's toFlexColumnStyle): flex-basis starts at
// preferredWidth, flex-grow distributes leftover space equally across every
// column except Type, which stays pinned to its own preferredWidth (same
// reasoning as Settlement's own Remarks: short, plain enum text that reads
// as an orphaned island if over-grown), minWidth is a hard floor CSS itself
// enforces, flex-shrink lets every column give way before any single one is
// singled out.
function toFlexColumnStyle(layout: ColumnLayout<ColumnKey>): CSSProperties {
  return {
    flexGrow: layout.id === COLUMN_IDS.TYPE ? 0 : 1,
    flexShrink: 1,
    flexBasis: `${layout.preferredWidth}px`,
    minWidth: `${layout.minWidth}px`,
  };
}

const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.id, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-4') {
  return `group flex items-center text-${align} ${paddingCls} text-[14px] leading-[20px] font-semibold text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap ${
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  }`;
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

// Proper-cases raw uppercase sheet values for display only — copied
// verbatim from Settlement's toProperCase.
// Acronyms that must stay fully uppercase even when the rest of the string
// gets proper-cased (e.g. "STLM To MC", not "Stlm To Mc") — per explicit
// instruction after Settlement's own "STLM TO MC" remarks value got mangled.
const PROPER_CASE_UPPERCASE_EXCEPTIONS = new Set(['SDP', 'STLM', 'MC']);

function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => {
      if (/^[\s-]+$/.test(part)) return part;
      if (PROPER_CASE_UPPERCASE_EXCEPTIONS.has(part.toUpperCase())) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

// Per-code tint map — same scheme as Balance's own BrandBadge
// (app/agentbal/page.tsx), applied here too. Unknown codes fall back to the
// same neutral slate this badge used exclusively before.
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
// (possibly search-highlighted) display content, which can differ from the
// raw string.
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
  // Was orange, same hue as K1's own Brand badge — changed to yellow, a
  // color not used anywhere in the Brand tint palette (blue/cyan/purple/
  // violet/fuchsia/indigo/sky/orange/amber/teal), so a Nagad wallet pill
  // never gets confused for a K1 brand pill at a glance.
  NAGAD: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-900/50',
  ROCKET: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  BKASH: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-900/50',
  UPAY: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/50',
};

function walletBadgeClasses(wallet: string): string {
  return WALLET_BADGE_TINTS[wallet.toUpperCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

// `wallet` carries the raw value for the color lookup — `children` is the
// (possibly search-highlighted, proper-cased) display content.
function WalletBadge({ children, wallet }: { children: React.ReactNode; wallet: string }) {
  return (
    <span className={`inline-flex h-[24px] items-center rounded-[999px] border px-2 py-1 text-[12px] font-medium transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletBadgeClasses(wallet)}`}>
      {children}
    </span>
  );
}

// Re-triggers a short opacity+translateY fade whenever `value` changes (e.g.
// after Refresh resolves with new numbers) — same pattern as
// SettlementSummary's own FadeValue, duplicated here since this page's KPI
// cards are now bespoke, not built on that shared component.
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

// Row actions menu (⋮) — copied verbatim from Settlement's RowActionsCell.
// Edit opens the (UI-only, prototype) RecordFormModal; View Details/Delete
// stay disabled placeholders, matching Settlement's own current state.
function RowActionsCell({ row, onEdit }: { row: TopUpRow; onEdit: (row: TopUpRow) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Keeps the portal mounted for 150ms after close so the closing
  // opacity/scale transition (driven by `open` below) can play before React
  // unmounts it — same pattern as the Columns menu.
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (open) {
      setRendered(true);
    } else {
      const timeout = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timeout);
    }
  }, [open]);

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
      `Brand: ${row.brand}`,
      `Leader: ${toProperCase(row.leader)}`,
      `Agent Name: ${toProperCase(row.agentName)}`,
      `Wallet: ${toProperCase(row.wallet)}`,
      `Amount: ${displayNum(row.amount)}`,
      `Type: ${toProperCase(row.type)}`,
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
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#94A3B8] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#F1F5F9] hover:text-[#475569] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:hover:bg-white/5"
      >
        <MoreVertical size={16} />
      </button>
      {rendered && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, transformOrigin: 'top right' }}
          className={`z-[9999] w-36 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl transition-[transform,opacity] duration-150 ease-[var(--ease-out-strong)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] ${
            open ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          }`}
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

const AGENT_NAME_SKELETON_WIDTHS = [55, 70, 85];
const TYPE_SKELETON_WIDTHS = [50, 65, 80];
const AMOUNT_SKELETON_WIDTHS = [26, 30, 24, 28];
const WALLET_SKELETON_WIDTHS = [48, 60, 52, 56];

function renderSkeletonCell(col: ColumnDef, rowIndex: number, style: CSSProperties) {
  const key = col.id;
  const base = 'flex items-center px-4 py-[14px]';
  switch (key) {
    case COLUMN_IDS.BRAND:
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div className="dt-skeleton h-[28px] w-9 rounded-full" />
        </div>
      );
    case COLUMN_IDS.LEADER:
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div className="dt-skeleton h-3 w-2/3 rounded-md" />
        </div>
      );
    case COLUMN_IDS.AGENT_NAME:
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${AGENT_NAME_SKELETON_WIDTHS[rowIndex % AGENT_NAME_SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      );
    case COLUMN_IDS.WALLET:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div
            className="dt-skeleton h-6 rounded-full"
            style={{ width: WALLET_SKELETON_WIDTHS[rowIndex % WALLET_SKELETON_WIDTHS.length] }}
          />
        </div>
      );
    case COLUMN_IDS.AMOUNT:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div className="dt-skeleton h-3 rounded-md" style={{ width: `${AMOUNT_SKELETON_WIDTHS[rowIndex % AMOUNT_SKELETON_WIDTHS.length]}%` }} />
        </div>
      );
    case COLUMN_IDS.TYPE:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${TYPE_SKELETON_WIDTHS[rowIndex % TYPE_SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      );
    case COLUMN_IDS.DATE:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-end`}>
          <div className="dt-skeleton h-3 rounded-md" style={{ width: '50%' }} />
        </div>
      );
    case COLUMN_IDS.ACTIONS:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div className="dt-skeleton h-8 w-8 rounded-[8px]" />
        </div>
      );
    default:
      return null;
  }
}

function renderCell(row: TopUpRow, col: ColumnDef, style: CSSProperties, onEdit: (row: TopUpRow) => void, searchTerm: string) {
  const key = col.id;
  const base = `whitespace-nowrap overflow-hidden text-ellipsis px-4 py-[14px] text-${COLUMN_ALIGN[key]} text-[13px] leading-[20px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  switch (key) {
    case COLUMN_IDS.BRAND:
      return <div key={key} role="cell" style={style} className={base}><BrandBadge brand={row.brand}>{highlightMatch(row.brand, searchTerm)}</BrandBadge></div>;
    case COLUMN_IDS.LEADER: {
      const leaderText = row.leader && row.leader !== '-' ? toProperCase(row.leader) : '−';
      return <div key={key} role="cell" style={style} title={leaderText} className={base}>{highlightMatch(leaderText, searchTerm)}</div>;
    }
    case COLUMN_IDS.AGENT_NAME: {
      const agentNameText = row.agentName.toUpperCase();
      return <div key={key} role="cell" style={style} title={agentNameText} className={base}>{highlightMatch(agentNameText, searchTerm)}</div>;
    }
    case COLUMN_IDS.WALLET:
      return <div key={key} role="cell" style={style} className={base}><WalletBadge wallet={row.wallet}>{highlightMatch(toProperCase(row.wallet), searchTerm)}</WalletBadge></div>;
    case COLUMN_IDS.AMOUNT:
      return <div key={key} role="cell" style={style} className={`${base} !text-[12px] font-semibold tabular-nums`}>{highlightMatch(displayNum(row.amount), searchTerm)}</div>;
    case COLUMN_IDS.TYPE: {
      // Formal-cased for display — the sheet's own raw value is ALL CAPS
      // ("BUNDLE TRANSFER"), same treatment as Wallet's toProperCase above.
      const typeText = row.type && row.type !== '-' ? toProperCase(row.type) : '−';
      return <div key={key} role="cell" style={style} title={typeText} className={base}>{highlightMatch(typeText, searchTerm)}</div>;
    }
    case COLUMN_IDS.DATE: {
      const dateText = formatDateDisplay(row.date);
      return <div key={key} role="cell" style={style} className={base}>{highlightMatch(dateText, searchTerm)}</div>;
    }
    case COLUMN_IDS.ACTIONS:
      return <div key={key} role="cell" style={style} className={`${base} flex items-center justify-center`}><RowActionsCell row={row} onEdit={onEdit} /></div>;
    default:
      return null;
  }
}

export default function TopUpPage() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
  // Real Balance Shop Agent roster — same source/purpose as Settlement's
  // openingAgentNames (app/stlm/page.tsx): the full ~3,486-agent list from
  // Opening Balance's own "Opening AG" sheet, not just today's rows.
  const [openingAgentNames, setOpeningAgentNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  // SettlementSummary's KPI row — real counts/totals computed in fetchData
  // from the SAME "AG BD STLM + TOPUP" sheet the table itself reads (it
  // carries several weeks of rows, not just today's; isToday()/isYesterday()
  // narrow it down). Not derived from topUpRows itself, since that's already
  // narrowed to today only — see fetchData for the actual computation.
  const [kpiStats, setKpiStats] = useState<TopUpKpiStats>(EMPTY_KPI_STATS);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [editingRow, setEditingRow] = useState<TopUpRow | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);

  // Toolbar filters — Brand/Leader/Wallet, same style/arrangement as
  // Balance (app/agentbal/page.tsx). Only these 3 facets exist as real
  // columns on this page (no Wallet Type/Wallet Status here).
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [walletFilter, setWalletFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const refreshTooltip = useTooltip(refreshButtonRef);
  const exportTooltip = useTooltip(exportButtonRef);
  const columnsTooltip = useTooltip(columnsButtonRef);

  useEffect(() => {
    setMounted(true);
    const saved = getPreference<Record<string, boolean> | null>(COLUMN_VISIBILITY_STORAGE_KEY, null);
    if (!saved) return;
    setColumnDefs((current) =>
      current.map((col) => (col.id in saved ? { ...col, visible: saved[col.id] } : col))
    );
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const visibility = Object.fromEntries(columnDefs.map((col) => [col.id, col.visible])) as Record<ColumnKey, boolean>;
    setPreference(COLUMN_VISIBILITY_STORAGE_KEY, visibility);
  }, [columnDefs, mounted]);

  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );

  const columnLayout = useMemo(() => calculateColumnLayout(visibleColumns), [visibleColumns]);
  const flexStyleById = useMemo(
    () => Object.fromEntries(
      columnLayout.map((layout) => [layout.id, toFlexColumnStyle(layout)])
    ) as Record<ColumnKey, CSSProperties>,
    [columnLayout]
  );

  const [rowsPhase, setRowsPhase] = useState<'skeleton' | 'fadingOut' | 'table'>('skeleton');

  useEffect(() => {
    if (loading) {
      setRowsPhase('skeleton');
      return;
    }
    setRowsPhase('fadingOut');
    const timer = setTimeout(() => setRowsPhase('table'), 120);
    return () => clearTimeout(timer);
  }, [loading]);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [res, agentRes, balRes] = await Promise.all([
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
      ]);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const text = await res.text();
      const agentText = agentRes.ok ? await agentRes.text() : '';
      const balText = balRes.ok ? await balRes.text() : '';

      // Keys into leaderMap/brandGroups/agentBrandOverride below are
      // normalized (uppercase + all whitespace stripped), not just
      // uppercased — same fix already applied to app/agentbal/page.tsx's
      // Top Up/Settlement sums: the sheets' own agent-name columns aren't
      // always cased/spaced the same as each other (e.g. "Konan001 " vs
      // "KONAN001"), which silently dropped that agent's Leader/Brand
      // lookup since the plain-uppercase key never matched.
      const normalizeAgentKey = (name: string): string => name.toUpperCase().replace(/\s+/g, '');

      // build agentName → leader lookup from opening sheet
      const leaderMap: Record<string, string> = {};
      const openingNames = new Set<string>();
      if (agentText) {
        agentText.trim().split('\n').slice(1).forEach(line => {
          const cols = line.split(',');
          const name = rawVal(cols[0]);
          const leader = rawVal(cols[3]);
          // Uppercased before adding — the real table always displays Agent
          // Name via .toUpperCase(), so the roster feeding Add/Edit's
          // combobox and Bulk Import's validation should match that same
          // canonical casing regardless of how the sheet itself has it stored.
          if (name && name !== '-' && name !== 'OLD') openingNames.add(name.toUpperCase());
          if (name && leader) leaderMap[normalizeAgentKey(name)] = leader;
        });
      }
      setOpeningAgentNames(Array.from(openingNames).sort((a, b) => a.localeCompare(b)));

      // Brand cross-reference: "SSP AG BalanceLimit" col G (index 6) is the
      // Group text; same computeBrand/resolveBrand priority logic as
      // Cashout's own Agent Balance page, keyed by the bare wallet name.
      const brandGroups: Record<string, string[]> = {};
      if (balText) {
        balText.trim().split('\n').slice(1).forEach(line => {
          const cols = line.split(',');
          const name = rawVal(cols[1]);
          const group = rawVal(cols[6]);
          if (name && group && group !== '-') {
            (brandGroups[normalizeAgentKey(name)] ??= []).push(group);
          }
        });
      }

      // "AG BD STLM + TOPUP" is Cashout's own dedicated Settlement + Top Up
      // sheet — Top Up lives in cols B-F (indices 1-5): To Agent/Amount/
      // Date/Wallet/Type (the sheet's own header row mislabels cols D/E as
      // "Wallet"/"Date" — the actual data order matches this, confirmed by
      // sampling), amounts stored positive. Cols H-L are a separate
      // Settlement block (see app/stlm/page.tsx) and cols Q-AA are a
      // last-month archive — neither belongs here.
      const lines = text.trim().split('\n').slice(1);
      const topUp: TopUpRow[] = [];

      // One canonical brand per shop, not per row — see app/stlm/page.tsx's
      // identical rationale (agentBrandOverride). Unchanged data logic.
      const agentBrandOverride: Record<string, string> = {};
      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const toAgent = rawVal(cols[1]);
          if (!toAgent || toAgent === '-') return;
          const suffixBrand = extractBrandSuffix(toAgent);
          if (suffixBrand) {
            agentBrandOverride[normalizeAgentKey(stripBrandSuffix(toAgent))] = suffixBrand;
          }
        });

      lines
        .filter(line => line.trim() !== '')
        .forEach((line, index) => {
          const cols = line.split(',');
          const toAgent = rawVal(cols[1]);
          if (toAgent && toAgent !== '-') {
            const bareAgent = stripBrandSuffix(toAgent);
            const bareAgentKey = normalizeAgentKey(bareAgent);
            topUp.push({
              agentName: bareAgent,
              wallet: rawVal(cols[4]),
              amount: rawVal(cols[2]),
              date: rawVal(cols[3]),
              type: rawVal(cols[5]),
              leader: leaderMap[bareAgentKey] || '−',
              brand: agentBrandOverride[bareAgentKey] ?? resolveBrand(brandGroups[bareAgentKey] ?? [], toAgent),
              _id: index,
            });
          }
        });

      // Split out so both the table's "today only" rows and the KPI row's
      // "today vs yesterday" comparison can be computed from one pass over
      // the full (unfiltered-by-date) sheet, instead of the table's own
      // isToday() filter discarding yesterday's rows before the KPI row
      // ever gets a chance to see them. Same pattern as app/stlm/page.tsx.
      const todayTopUp = topUp.filter(row => isToday(row.date));
      const yesterdayTopUp = topUp.filter(row => isYesterday(row.date));

      setTopUpRows(todayTopUp);
      // A fresh fetch means brand-new row objects (and _ids reset) — any
      // previous selection no longer refers to anything real.
      setSelectedIds(new Set());
      setKpiStats({
        todayCount: todayTopUp.length,
        todayAmount: todayTopUp.reduce((sum, row) => sum + parseAmount(row.amount), 0),
        yesterdayCount: yesterdayTopUp.length,
        yesterdayAmount: yesterdayTopUp.reduce((sum, row) => sum + parseAmount(row.amount), 0),
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

  const searchedRows = topUpRows.filter((row) => {
    const haystack = `${row.agentName} ${row.amount} ${row.type} ${row.date} ${row.wallet} ${row.brand} ${row.leader}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  // Toolbar filters — Brand/Leader/Wallet, same shape/behavior as Balance
  // (app/agentbal/page.tsx): options are the full universe of values seen
  // in topUpRows, faceted counts below narrow per-dropdown, and
  // filteredRows is the one that actually gates the table.
  const brandOptions = useMemo(
    () => Array.from(new Set(topUpRows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [topUpRows]
  );
  const leaderOptions = useMemo(
    () => Array.from(new Set(topUpRows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [topUpRows]
  );
  const walletOptions = useMemo(
    () => Array.from(new Set(topUpRows.map((row) => row.wallet).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [topUpRows]
  );

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const isWalletChecked = (name: string) => walletFilter[name] !== false;

  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const anyWalletUnchecked = walletOptions.some((name) => !isWalletChecked(name));

  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;
  const selectedWalletCount = walletOptions.filter((name) => isWalletChecked(name)).length;

  const anyFilterActive = anyBrandUnchecked || anyLeaderUnchecked || anyWalletUnchecked;

  const resetAllFilters = useCallback(() => {
    setBrandFilter({});
    setLeaderFilter({});
    setWalletFilter({});
    setBrandMenuOpen(false);
    setLeaderMenuOpen(false);
    setWalletMenuOpen(false);
  }, []);

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (walletOptions.some((name) => walletFilter[name] === false)) {
      list = list.filter((row) => walletFilter[row.wallet] !== false);
    }
    return list;
  }, [searchedRows, brandFilter, brandOptions, leaderFilter, leaderOptions, walletFilter, walletOptions]);

  // Faceted option counts — each omits its own facet's clause so unchecking
  // an option in a dropdown doesn't shrink its own list toward zero.
  const brandFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (walletOptions.some((name) => walletFilter[name] === false)) {
      list = list.filter((row) => walletFilter[row.wallet] !== false);
    }
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.brand, (counts.get(row.brand) ?? 0) + 1);
    return brandOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, walletFilter, walletOptions, brandOptions]);

  const leaderFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletOptions.some((name) => walletFilter[name] === false)) {
      list = list.filter((row) => walletFilter[row.wallet] !== false);
    }
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.leader, (counts.get(row.leader) ?? 0) + 1);
    return leaderOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [searchedRows, brandFilter, brandOptions, walletFilter, walletOptions, leaderOptions]);

  const walletFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.wallet, (counts.get(row.wallet) ?? 0) + 1);
    return walletOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [searchedRows, brandFilter, brandOptions, leaderFilter, leaderOptions, walletOptions]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: TopUpRow) => {
        switch (sortColumn) {
          case COLUMN_IDS.BRAND:
            return row.brand.toLowerCase();
          case COLUMN_IDS.LEADER:
            return row.leader.toLowerCase();
          case COLUMN_IDS.AGENT_NAME:
            return row.agentName.toLowerCase();
          case COLUMN_IDS.WALLET:
            return row.wallet.toLowerCase();
          case COLUMN_IDS.AMOUNT:
            return parseAmount(row.amount);
          case COLUMN_IDS.TYPE:
            return row.type.toLowerCase();
          case COLUMN_IDS.DATE:
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
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  const pageRowIds = pagedRows.map((row) => row._id);
  const selectedOnPageCount = pageRowIds.filter((id) => selectedIds.has(id)).length;
  const allOnPageSelected = pageRowIds.length > 0 && selectedOnPageCount === pageRowIds.length;

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
  // page's raw "M/D/YYYY" row storage convention — copied verbatim from
  // Settlement's parseDisplayDateToStorage.
  const parseDisplayDateToStorage = (display: string): string => {
    const parsed = new Date(display);
    if (isNaN(parsed.getTime())) return display;
    return `${parsed.getMonth() + 1}/${parsed.getDate()}/${parsed.getFullYear()}`;
  };

  const handleBulkEditApply = useCallback((updates: BulkEditUpdates) => {
    setTopUpRows((current) => current.map((row) => {
      if (!selectedIds.has(row._id)) return row;
      return {
        ...row,
        ...(updates.wallet !== undefined ? { wallet: updates.wallet } : {}),
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

  // Type is a fixed literal for Cashout Top Up ("BUNDLE TRANSFER") — never
  // observed as anything else in real sheet data, so the field is a
  // closed, single-option combobox (no allowCustom) rather than a free
  // dropdown, matching how the row is always actually populated.
  const topupRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: SETTLEMENT_BRAND_OPTIONS, required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: openingAgentNames, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: CASHOUT_WALLET_OPTIONS, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'type', label: 'Type', kind: 'combobox', options: TOPUP_TYPE_OPTIONS, required: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [openingAgentNames]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: TopUpRow, key: ColumnKey) => {
      switch (key) {
        case COLUMN_IDS.BRAND:
          return row.brand;
        case COLUMN_IDS.LEADER:
          return row.leader;
        case COLUMN_IDS.AGENT_NAME:
          return row.agentName;
        case COLUMN_IDS.WALLET:
          return row.wallet;
        case COLUMN_IDS.AMOUNT:
          return displayNum(row.amount);
        case COLUMN_IDS.TYPE:
          return row.type;
        case COLUMN_IDS.DATE:
          return row.date;
        default:
          return '';
      }
    };

    const exportColumns = visibleColumns.filter((col) => col.id !== COLUMN_IDS.ACTIONS);
    const headers = exportColumns.map((col) => col.label);
    const data = sortedRows.map((row) => exportColumns.map((col) => getExportValue(row, col.id)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Top Up');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_TOPUP_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Balance-style KPI cards (bespoke, not SettlementSummary — that component
  // is shared with the 3 Send Money equivalent pages, which weren't part of
  // this redesign). Count metrics have no subtitle (would just duplicate the
  // big value); amount metrics get an abbreviated big value + full-figure
  // subtitle, matching Balance's Total DP/Total WD pattern exactly.
  const kpis = useMemo(() => [
    {
      label: "Today's Total Count", icon: Hash,
      accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-50 dark:bg-indigo-500/10',
      bigValue: kpiStats.todayCount.toLocaleString('en-US'), subtitle: undefined as string | undefined,
    },
    {
      label: "Today's Total Amount", icon: Banknote,
      accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-50 dark:bg-emerald-500/10',
      bigValue: fmtAbbrev(kpiStats.todayAmount), subtitle: fmt(kpiStats.todayAmount) as string | undefined,
    },
    {
      label: "Yesterday's Total Count", icon: Hash,
      accent: 'text-slate-500 dark:text-slate-400', iconBg: 'bg-slate-100 dark:bg-slate-500/10',
      bigValue: kpiStats.yesterdayCount.toLocaleString('en-US'), subtitle: undefined as string | undefined,
    },
    {
      label: "Yesterday's Total Amount", icon: Banknote,
      accent: 'text-orange-500 dark:text-orange-400', iconBg: 'bg-orange-50 dark:bg-orange-500/10',
      bigValue: fmtAbbrev(kpiStats.yesterdayAmount), subtitle: fmt(kpiStats.yesterdayAmount) as string | undefined,
    },
  ], [kpiStats]);

  const hasAnyRecords = topUpRows.length > 0;
  const emptyStateNode = !hasAnyRecords ? (
    <EmptyState
      icon={Inbox}
      title="No Top Up Records"
      description="Top Up records will appear here once they are created or imported."
      action={
        <button type="button" onClick={() => setNewRecordOpen(true)} className={EMPTY_STATE_PRIMARY_BUTTON}>
          Add Record
        </button>
      }
    />
  ) : (
    <EmptyState
      title="No matching Top Up records."
      description="Try changing your search or filters."
      action={
        <button type="button" onClick={clearSearch} className={EMPTY_STATE_ACTION_BUTTON}>
          Clear Search
        </button>
      }
    />
  );

  return (
    <div
      className="h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]"
      style={{ fontFamily: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif' }}
    >
      <SettlementHeader
        icon={PlusCircle}
        title="Top Up"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />
      <div className="w-full border-t border-border bg-[#f4f6fb] px-4 py-3 dark:bg-[#1c1c1e] md:px-6">
        <div className="flex gap-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[80.5px] flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 dark:bg-[#2a2a2d]">
                <div className="flex h-full items-center gap-3">
                  <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="mt-1.5 h-6 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                </div>
              </div>
            ))
          ) : (
            kpis.map((kpi) => (
              <div
                key={kpi.label}
                className="h-[80.5px] flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm dark:bg-[#2a2a2d]"
              >
                <div className="flex h-full items-center gap-3">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${kpi.iconBg}`}>
                    <kpi.icon size={16} className={kpi.accent} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium leading-snug text-muted-foreground truncate">{kpi.label}</p>
                    <FadeValue value={kpi.bigValue} className={`font-bold leading-tight text-foreground ${kpi.subtitle ? 'text-[21px]' : 'text-[28px]'}`} />
                    {kpi.subtitle && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground truncate">{kpi.subtitle}</p>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-1">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            {/* Same style/arrangement as Balance (app/agentbal/page.tsx):
                Filters (mr-3) -> Search (flex-1, rounded-full) -> Actions
                (ml-3), replacing the old Toolbar/Toolbar.Left/Toolbar.Right
                layout. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-[#E5E7EB] px-4 py-3 dark:border-[#3a3a3d]">
              {loading ? (
                <div className="mr-3 flex shrink-0 items-center gap-3">
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[98px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[100px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />
                </div>
              ) : (
                <div className="mr-3 flex shrink-0 items-center gap-3">
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
                      label="Wallet"
                      icon={WalletIcon}
                      anyUnchecked={anyWalletUnchecked}
                      selectedCount={selectedWalletCount}
                      menuOpen={walletMenuOpen}
                      buttonRef={walletButtonRef}
                      onClick={() => setWalletMenuOpen((current) => !current)}
                    />
                    <FilterDropdown
                      open={walletMenuOpen}
                      onOpenChange={setWalletMenuOpen}
                      anchorRef={walletButtonRef}
                      options={walletFilterOptions}
                      selected={walletFilter}
                      onChange={setWalletFilter}
                    />
                  </div>
                  <ResetFiltersButton anyFilterActive={anyFilterActive} onClick={resetAllFilters} />
                </div>
              )}

              <div className="flex h-10 flex-1 min-w-[200px] items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-[16px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                {loading ? (
                  <div className="h-3 w-32 dt-skeleton rounded-md" />
                ) : (
                  <>
                    <Search size={16} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
                    <input
                      aria-label="Search agent, wallet, or brand"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[13px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
                      placeholder="Search agent, wallet, or brand..."
                    />
                  </>
                )}
              </div>

              {loading ? (
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[88px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[108px]" />
                </div>
              ) : (
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  {selectionBarRendered ? (
                    <div className="flex flex-wrap items-center gap-3 dt-bar-fade-in">
                      <span className="text-[13px] font-medium text-foreground">{selectedIds.size} Selected</span>
                      <button
                        type="button"
                        onClick={() => setBulkEditOpen(true)}
                        className="inline-flex h-9 items-center rounded-[8px] bg-indigo-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                      >
                        Bulk Edit
                      </button>
                    </div>
                  ) : (
                    <AddRecordDropdown
                      templateModule="topup"
                      onNewRecord={() => setNewRecordOpen(true)}
                      onBulkImport={() => setBulkImportOpen(true)}
                      buttonClassName="bg-indigo-600 hover:bg-indigo-700"
                    />
                  )}
                  <div className="relative">
                    <button type="button" ref={refreshButtonRef} onClick={fetchData} aria-label="Refresh" {...refreshTooltip.handlers} className={ICON_BUTTON}>
                      <RefreshCw size={16} className={spinning ? 'animate-spin' : ''} />
                      <span className="hidden xl:inline">Refresh</span>
                    </button>
                    {refreshTooltip.rendered && <Tooltip label="Refresh" open={refreshTooltip.open} pos={refreshTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={handleExport} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={16} />
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
                      aria-controls="topup-columns-popover"
                      aria-label="Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_BUTTON}
                    >
                      <Columns3 size={16} />
                      <span className="hidden xl:inline">Columns</span>
                    </button>
                    {columnsTooltip.rendered && <Tooltip label="Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} onlyWhenCompact />}
                    <ColumnsDropdown
                      id="topup-columns-popover"
                      open={columnsMenuOpen}
                      onOpenChange={setColumnsMenuOpen}
                      anchorRef={columnsButtonRef}
                      columns={columnDefs.map((col) => ({ key: col.id, label: col.label, visible: col.visible, hideable: col.hideable }))}
                      onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.id === key ? { ...c, visible: !c.visible } : c)))}
                      onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <DataTable.ScrollArea className="hidden sm:block">
              {(isScrolled) => (
                <>
                  <DataTable.StickyHeader isScrolled={isScrolled}>
                  <div role="row" className="flex h-[48px] items-center">
                    <div role="columnheader" className="flex h-full w-[44px] shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        aria-label="Select all rows on this page"
                        checked={allOnPageSelected}
                        onChange={toggleSelectAllOnPage}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </div>
                    {visibleColumns.map((col) => (
                      <div
                        key={col.id}
                        role="columnheader"
                        style={flexStyleById[col.id]}
                        aria-sort={!col.sortable ? undefined : sortColumn === col.id ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={headerCellClasses(COLUMN_ALIGN[col.id], 'px-4')}>
                        {!col.sortable ? (
                          <span>{col.label}</span>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Sort by ${col.label}${sortColumn === col.id ? (sortDirection === 'asc' ? ', ascending' : ', descending') : ''}`}
                            onClick={() => {
                              if (sortColumn === col.id) {
                                setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortColumn(col.id as SortColumn);
                                setSortDirection('asc');
                              }
                            }}
                            className={`relative flex w-full items-center gap-1.5 text-${COLUMN_ALIGN[col.id]} transition-[color,transform] duration-150 ease-[var(--ease-out-strong)] hover:text-[#111827] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:hover:text-white ${
                              COLUMN_ALIGN[col.id] === 'right' ? 'justify-end' : COLUMN_ALIGN[col.id] === 'center' ? 'justify-center' : 'justify-start'
                            }`}
                          >
                            {COLUMN_ALIGN[col.id] === 'center' ? (
                              <span className="relative inline-flex items-center">
                                {col.label}
                                <span className="absolute left-full ml-1.5 flex items-center">
                                  <SortIcon active={sortColumn === col.id} direction={sortDirection} />
                                </span>
                              </span>
                            ) : (
                              <>
                                <span>{col.label}</span>
                                <SortIcon active={sortColumn === col.id} direction={sortDirection} />
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  </DataTable.StickyHeader>
                <div
                  key={rowsPhase === 'table' ? 'data' : 'skeleton'}
                  role="rowgroup"
                  className={rowsPhase === 'fadingOut' ? 'dt-fade-out' : 'dt-fade-in'}
                >
                  {rowsPhase !== 'table' ? Array.from({ length: 11 }).map((_, i) => (
                    <div
                      key={i}
                      role="row"
                      className="flex h-[52px] items-center border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32]"
                    >
                      <div className="h-full w-[44px] shrink-0" />
                      {visibleColumns.map((col) => renderSkeletonCell(col, i, flexStyleById[col.id]))}
                    </div>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    const isChecked = selectedIds.has(row._id);
                    return (
                      <div
                        key={i}
                        tabIndex={0}
                        role="row"
                        onClick={() => toggleRowSelection(row._id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleRowSelection(row._id);
                          }
                        }}
                        aria-selected={isChecked}
                        className={`flex h-[52px] items-center cursor-pointer border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32] transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB] ${
                          isChecked
                            ? 'bg-[color:var(--product-accent-soft)]'
                            : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.025]'
                        }`}
                      >
                        <div
                          role="cell"
                          className="flex h-full w-[44px] shrink-0 items-center justify-center"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select row for ${row.agentName}`}
                            checked={isChecked}
                            onChange={() => toggleRowSelection(row._id)}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        </div>
                        {visibleColumns.map((col) => renderCell(row, col, flexStyleById[col.id], setEditingRow, searchTerm))}
                      </div>
                    );
                  }) : rowsPhase === 'table' && (
                    <div role="row">
                      <div role="cell">
                        {emptyStateNode}
                      </div>
                    </div>
                  )}
                </div>
                </>
              )}
            </DataTable.ScrollArea>

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
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName.toUpperCase()}</p>
                          <p className="truncate text-[12px] font-normal text-muted-foreground">{row.brand} · {toProperCase(row.wallet)}{row.leader && row.leader !== '−' ? ` · ${toProperCase(row.leader)}` : ''}</p>
                        </div>
                        <span className="shrink-0 text-[12px] font-normal text-muted-foreground">{formatDateDisplay(row.date)}</span>
                      </div>

                      <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
                        <span className="text-[11px] font-normal text-muted-foreground">{row.type && row.type !== '-' ? toProperCase(row.type) : '−'}</span>
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
        title="Edit Top Up Record"
        fields={topupRecordFields}
        initialValues={editingRow ? {
          brand: editingRow.brand,
          // Uppercase, not toProperCase — Agent Name's canonical form is
          // full caps (matches the live table's own .toUpperCase()
          // display), unlike Wallet below which really is Title Case.
          agentName: editingRow.agentName.toUpperCase(),
          wallet: toProperCase(editingRow.wallet),
          amount: String(parseAmount(editingRow.amount)),
          type: editingRow.type,
          date: formatDateDisplay(editingRow.date),
        } : {}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        title="New Top Up Record"
        fields={topupRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        moduleLabel="Top Up Records"
        templateModule="topup"
        moduleKind="topup"
        accentButtonClassName="bg-indigo-600 hover:bg-indigo-700"
        brandOptions={SETTLEMENT_BRAND_OPTIONS}
        walletOptions={CASHOUT_WALLET_OPTIONS}
        agentRoster={openingAgentNames}
        typeOptions={TOPUP_TYPE_OPTIONS}
      />

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        walletOptions={CASHOUT_WALLET_OPTIONS}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />
    </div>
  );
}
