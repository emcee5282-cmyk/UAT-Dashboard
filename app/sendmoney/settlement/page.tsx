'use client';

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronUp, ChevronDown, ChevronsUpDown, Columns3, Download, ArrowLeftRight, RefreshCw, MoreVertical, Copy, Pencil, Eye, Trash2, Inbox, Tag, User, Wallet as WalletIcon, FilterX, Upload, Plus, CheckSquare, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Manrope, Space_Grotesk } from 'next/font/google';
import SettlementHeader from '@/app/components/SettlementHeader';
import FilterDropdown from '@/app/components/FilterDropdown';
import ColumnsDropdown from '@/app/components/ColumnsDropdown';
import DataTable from '@/app/components/DataTable';
import CompactTableFooter from '@/app/components/CompactTableFooter';
import EmptyState from '@/app/components/EmptyState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import RecordFormModal, { type RecordFormField } from '@/app/components/RecordFormModal';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';
import BulkImportModal from '@/app/components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '@/app/components/BulkEditModal';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { displayNum, parseAmount, fmtAbbrev, fmt, exportNum } from '@/app/lib/format';
import { getPreference, setPreference } from '@/app/lib/preferences';
import DateRangeFilter, { presetOf, daysInRange, type DateRangeValue } from '@/app/components/DateRangeFilter';
import { SETTLEMENT_BRAND_OPTIONS, SENDMONEY_WALLET_OPTIONS, SETTLEMENT_REMARKS_SUGGESTIONS } from '@/app/lib/settlementOptions';

function matchOptionCaseInsensitive(value: string, options: string[]): string {
  return options.find((option) => option.toLowerCase() === value.toLowerCase()) ?? value;
}

// Page-scoped font override (Manrope for body/labels, Space Grotesk for
// tabular-nums), matching Daily Txn Entry's own treatment and Top Up's port
// of it (app/topup/page.tsx) — per explicit instruction, Settlement now
// matches Top Up's typeface exactly, not just its font SIZE. Every other
// page keeps Inter.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

// Responsive action buttons (Refresh/Export/Columns) — icon+text when the
// viewport has room, collapsing to icon-only (40x40, no padding) once space
// gets tight. Copied verbatim from Balance (app/agentbal/page.tsx) so this
// page's toolbar matches its style/arrangement exactly, per explicit
// instruction.
// Compact sizing (matches Wallet Status/Transfer Queue/Top Up's own
// density): h-10/rounded-[12px]/text-[13px] scaled down to h-8/
// rounded-[10px]/text-[11px], gap-1.5 -> gap-[5px] — was left over at the
// old full size while those other pages had already migrated, per
// explicit instruction.
const ICON_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label, unlike ICON_BUTTON's
// xl: breakpoint reveal) — Refresh/Columns per explicit instruction, tooltip
// carries the label instead.
const ICON_ONLY_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Same shell as ICON_ONLY_BUTTON, indigo text/icon instead of slate —
// Refresh only, per explicit instruction; Columns stays neutral.
const REFRESH_ICON_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white text-[11px] font-medium text-indigo-600 transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-indigo-400 dark:hover:bg-white/5';

// Same shell as ICON_BUTTON — border, white bg, hover/active treatment all
// identical — with only the text/icon color swapped to indigo. Kept the
// SAME indigo as Cashout (not Send Money's own teal --product-accent)
// per explicit instruction: selected-row/Bulk Actions/New should read
// identically across both products, not per-product themed. Replaces the
// old solid-fill "+ Add" button: no more filled CTA, just a colored label
// on the same neutral button shell as Refresh/Export/Columns.
const NEW_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-indigo-600 transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-indigo-400 dark:hover:bg-white/5';

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
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out-strong)] ${
          anyFilterActive
            ? 'cursor-pointer border-[#E2E8F0] bg-white text-indigo-600 hover:border-[#FCA5A5] hover:bg-[#FEF2F2] hover:text-[#DC2626] active:scale-[0.97] active:border-[#FCA5A5] active:bg-[#FEF2F2] active:text-[#DC2626] dark:border-[#262B38] dark:bg-[#12151D] dark:text-indigo-400'
            : 'cursor-default border-[#E2E8F0] bg-white text-[#475569] opacity-40 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF]'
        }`}
      >
        <FilterX size={16} fill={anyFilterActive ? 'currentColor' : 'none'} />
      </button>
      {tooltip.rendered && <Tooltip label="Reset all filters" open={tooltip.open} pos={tooltip.pos} />}
    </div>
  );
}

// Bulk Actions dropdown — appears alongside (never instead of) the
// standard toolbar per the bulk-selection spec: New/Upload/Export/Refresh/
// Columns stay exactly where they are; this is purely an added segment
// while 1+ rows are checked. Portal-rendered, same click-outside-close
// pattern as RowActionsCell's own kebab menu. Uses the SAME indigo as
// Cashout (not Send Money's own teal --product-accent) per explicit
// instruction — selection UI should read identically across both products.
function BulkActionsMenu({
  count,
  onBulkEdit,
  onExportSelected,
  onClearSelection,
}: {
  count: number;
  onBulkEdit: () => void;
  onExportSelected: () => void;
  onClearSelection: () => void;
}) {
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

  return (
    <div className="flex items-center gap-2 dt-bar-fade-in">
      {/* Compact outlined chip — matches the rest of the toolbar's h-8/
          text-[11px]/bordered convention instead of an unbounded 13px
          label, per explicit instruction. */}
      <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white px-[10px] text-[11px] font-medium text-[#475569] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF]">
        <CheckSquare size={12} className="text-[var(--ui-accent)]" />
        {count} Selected
      </span>
      <div className="relative">
        <button
          type="button"
          ref={btnRef}
          onClick={() => {
            const rect = btnRef.current?.getBoundingClientRect();
            if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
            setOpen((current) => !current);
          }}
          aria-haspopup="true"
          aria-expanded={open}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--ui-accent)] px-[10px] text-[11px] font-medium text-white transition-[filter,transform] duration-150 ease-[var(--ease-out-strong)] hover:brightness-95 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)]"
        >
          Bulk Actions
          <ChevronDown size={12} className={`transition-transform duration-150 ease-[var(--ease-in-out-strong)] ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && typeof document !== 'undefined' && createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="z-[9999] w-48 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl dark:border-[#262B38] dark:bg-[#12151D]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => { setOpen(false); onBulkEdit(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <Pencil size={13} />
              Bulk Edit
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); onExportSelected(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <Download size={13} />
              Export Selected
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]"
            >
              <Trash2 size={13} />
              Delete Selected
            </button>
            <div className="my-1 border-t border-[#F1F5F9] dark:border-[#1A1E29]" />
            <button
              type="button"
              onClick={() => { setOpen(false); onClearSelection(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <X size={13} />
              Clear Selection
            </button>
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}

// EmptyState's action button for the no-search-results state (ghost/outline
// style) — mirrors Cashout Settlement's own EMPTY_STATE_ACTION_BUTTON
// (app/stlm/page.tsx) exactly.
const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#262B38] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// The genuinely-no-data empty state's "Add Record" — filled accent, Send
// Money's own var(--ui-accent) (this component doesn't portal, so the
// var resolves fine here, unlike the modals' own portal-scoping issue).
const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-[color:var(--ui-accent)] px-4 text-[13px] font-medium text-white transition-colors hover:opacity-90';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

// Range-based, not today/yesterday — the server resolves total/count for
// whatever [from, to] was requested (default: Effective Today, see
// transactionPageService.ts's getSettlementPageData) plus the equal-length
// prior period's total/count for the delta badge's comparison baseline.
type SettlementKpiStats = {
  total: number;
  count: number;
  previousPeriodTotal: number;
  previousPeriodCount: number;
};

const EMPTY_KPI_STATS: SettlementKpiStats = { total: 0, count: 0, previousPeriodTotal: 0, previousPeriodCount: 0 };

// "vs yesterday" only when the applied range IS today; otherwise "vs
// previous N days" (custom/week) or "vs same days last month" (month).
function deltaVsLabel(range: DateRangeValue, today: string): string {
  const preset = presetOf(range, today);
  if (preset === 'today') return 'vs yesterday';
  if (preset === 'month') return 'vs same days last month';
  return `vs previous ${daysInRange(range.from, range.to).length} days`;
}

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
  leader: string;
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

// Phase 7 — brand/agent-name resolution (parsing the wallet-name segments)
// moved server-side: transactionPageService.ts now returns each row's brand
// pre-resolved via agents.brand_id and agentName already in its bare
// (suffix-stripped) form, straight off agents.agent_code — the same
// canonical values scripts/migrate-data.ts already computes for the roster.
// resolveBrandFromWalletName/stripAgentNameSuffix that used to run here on
// every fetch are gone; displayBrand (below) is kept as the extension
// point for a future label override. 'SH' shows as-is (no override) per
// explicit instruction, matching the Wallet Status page's own Brand
// column.
const BRAND_DISPLAY_LABELS: Record<string, string> = {};

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

// Re-triggers a short opacity+translateY fade whenever `value` changes,
// matching Cashout Settlement's own (app/stlm/page.tsx) bespoke FadeValue —
// duplicated here since these KPI cards are bespoke, not SettlementSummary.
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

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's.
const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
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
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.REMARKS, label: 'Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.key, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneySettlementColumnVisibility';

const columns: { key: ColumnKey; label: string }[] = DEFAULT_COLUMNS.map((col) => ({ key: col.key, label: col.label }));

// Exact px sizing model copied from Cashout Settlement (app/stlm/page.tsx's
// DEFAULT_COLUMNS + toFlexColumnStyle) — by explicit instruction, this
// page's columns must render at the SAME position as Cashout's, not just an
// approximation. Cashout is a real CSS flexbox row (flexGrow:1 on every
// column except Remarks, which stays pinned to its own preferredWidth), so
// a fixed-% <table> can only match it at one coincidental reference width —
// at any other width the two diverge, since flexGrow distributes leftover
// space as an equal ABSOLUTE bonus per growable column, not a fixed ratio.
// This page can't use real flexbox (native <table> + table-fixed), so
// computeColumnWidthsPx below replicates the same algorithm in JS: growth
// splits the leftover width equally across every column but Remarks;
// shrink distributes proportional to each column's own preferredWidth
// (flexbox's flex-shrink:1 default weighting), floored at minWidth with a
// multi-pass freeze/redistribute once a column hits its floor — mirrors
// the CSS flex algorithm instead of approximating it.
const CASHOUT_COLUMN_SIZING: Record<ColumnKey, { minWidth: number; preferredWidth: number; grow: boolean }> = {
  brand: { minWidth: 90, preferredWidth: 149, grow: true },
  leader: { minWidth: 100, preferredWidth: 150, grow: true },
  agentName: { minWidth: 140, preferredWidth: 216, grow: true },
  wallet: { minWidth: 90, preferredWidth: 208, grow: true },
  amount: { minWidth: 115, preferredWidth: 244, grow: true },
  remarks: { minWidth: 160, preferredWidth: 243, grow: false },
  date: { minWidth: 110, preferredWidth: 149, grow: true },
  actions: { minWidth: 56, preferredWidth: 109, grow: true },
};

// The 44px checkbox <col> is a separate fixed-width sibling in Cashout's
// real flex row (flex-shrink:0, never shrinks/grows) — never a slice out of
// Brand's own share. `availableWidth` passed in must already have 44
// subtracted so the 7 data columns split exactly what Cashout's flex row
// would give them.
function computeColumnWidthsPx(availableWidth: number): Record<ColumnKey, number> {
  const entries = (Object.keys(CASHOUT_COLUMN_SIZING) as ColumnKey[]).map((key) => ({
    key,
    ...CASHOUT_COLUMN_SIZING[key],
  }));
  const totalPreferred = entries.reduce((sum, e) => sum + e.preferredWidth, 0);

  if (availableWidth >= totalPreferred) {
    const growable = entries.filter((e) => e.grow);
    const bonus = growable.length ? (availableWidth - totalPreferred) / growable.length : 0;
    const result = {} as Record<ColumnKey, number>;
    for (const e of entries) result[e.key] = e.preferredWidth + (e.grow ? bonus : 0);
    return result;
  }

  const state = entries.map((e) => ({ ...e, width: e.preferredWidth, frozen: false }));
  let deficit = totalPreferred - availableWidth;
  for (let pass = 0; pass < 6 && deficit > 0.5; pass++) {
    const active = state.filter((e) => !e.frozen);
    const basisSum = active.reduce((sum, e) => sum + e.preferredWidth, 0);
    if (basisSum <= 0) break;
    let applied = 0;
    for (const e of active) {
      const share = deficit * (e.preferredWidth / basisSum);
      const next = e.width - share;
      if (next <= e.minWidth) {
        applied += e.width - e.minWidth;
        e.width = e.minWidth;
        e.frozen = true;
      } else {
        applied += share;
        e.width = next;
      }
    }
    deficit -= applied;
  }
  const result = {} as Record<ColumnKey, number>;
  for (const e of state) result[e.key] = e.width;
  return result;
}

// Table's own floor — matches Cashout's summed minWidth (861px, 761 plus
// Leader's own 100px) plus the 44px checkbox column, so this page's
// horizontal-scroll fallback engages at the same point Cashout's per-column
// CSS minWidth floors would.
const TABLE_MIN_WIDTH_PX = 861 + 44;

// Size/weight/case matched to Top Up's own table header cells
// (app/topup/page.tsx: text-[11.5px] font-bold uppercase tracking-[0.03em])
// per explicit instruction — no flex/justify here, since overriding a
// <th>'s display away from table-cell would break the colgroup's
// table-fixed sizing (the alignment/justify logic instead lives on the
// inner sort button, same as this file's own pre-existing pattern).
function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-[8px]') {
  return `group ${paddingCls} text-[11.5px] leading-[20px] font-bold uppercase tracking-[0.03em] text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap text-${align}`;
}

// Per-wallet tint map — each wallet's own real brand color (Nagad orange,
// Rocket purple, Bkash pink, Upay red), same light-bg/border/text pattern
// used across this file's other badges. Unknown values fall back to the
// same neutral slate this badge used exclusively before.
const WALLET_BADGE_TINTS: Record<string, string> = {
  // Was orange, same hue as K1's own Brand badge — changed to yellow, a
  // color not used anywhere in the Brand tint palette, so a Nagad wallet
  // pill never gets confused for a K1 brand pill at a glance.
  NAGAD: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-900/50',
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

// Source data comes in as raw uppercase (e.g. "ALADDIN") — proper-cased for
// display only (Leader), copied verbatim from Cashout Settlement's own
// toProperCase (app/stlm/page.tsx).
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Row actions menu (⋮) — copied from Cashout Settlement (app/stlm/page.tsx).
// Edit and Delete are both real PostgreSQL mutations as of Phase 7; View
// Details stays a disabled placeholder (no detail view exists yet).
function RowActionsCell({ row, onEdit, onDelete }: { row: StlmRow; onEdit: (row: StlmRow) => void; onDelete: (row: StlmRow) => void }) {
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
      `Brand: ${displayBrand(row.brand)}`,
      `Leader: ${toProperCase(row.leader)}`,
      `Agent Name: ${row.agentName}`,
      `Wallet: ${row.wallet}`,
      `Amount: ${displayNum(row.amount)}`,
      `Type: ${row.remarks}`,
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
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#94A3B8] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#F1F5F9] hover:text-[#475569] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:hover:bg-white/5"
      >
        <MoreVertical size={16} />
      </button>
      {rendered && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, transformOrigin: 'top right' }}
          className={`z-[9999] w-36 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl transition-[transform,opacity] duration-150 ease-[var(--ease-out-strong)] dark:border-[#262B38] dark:bg-[#12151D] ${
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
          <div className="my-1 border-t border-[#F1F5F9] dark:border-[#1A1E29]" />
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
            onClick={() => { setOpen(false); onDelete(row); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
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

// Size AND row density matched to Top Up's own table body cells
// (app/topup/page.tsx: text-[12.5px], py-1.5 = 6px) per explicit
// instruction — color kept as this page's own established token (font
// style/size only, not color). Brand is plain text now (no badge — matches
// Top Up), Wallet keeps its badge.
function renderCell(row: StlmRow, key: ColumnKey, onEdit: (row: StlmRow) => void, onDelete: (row: StlmRow) => void, searchTerm: string) {
  const truncates = key === COLUMN_IDS.AGENT_NAME || key === COLUMN_IDS.REMARKS;
  // 'right'-aligned columns (Amount, Date) get extra right padding (28px
  // vs the usual 8px) mirroring the header's own reserved space — matches
  // Top Up exactly.
  const rightPad = COLUMN_ALIGN[key] === 'right' ? 'pl-[8px] pr-[28px]' : 'px-[8px]';
  const cellCls = `whitespace-nowrap ${truncates ? 'overflow-hidden text-ellipsis' : ''} ${rightPad} text-${COLUMN_ALIGN[key]} text-[12.5px] leading-[16px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  const base = `${cellCls} py-[6px]`;
  switch (key) {
    case 'brand':
      return <td key={key} title={displayBrand(row.brand)} className={base}>{highlightMatch(displayBrand(row.brand), searchTerm)}</td>;
    case 'leader': {
      const leaderText = row.leader && row.leader !== '-' ? toProperCase(row.leader) : '−';
      return <td key={key} title={leaderText} className={base}>{highlightMatch(leaderText, searchTerm)}</td>;
    }
    case 'agentName':
      return <td key={key} title={row.agentName} className={base}>{highlightMatch(row.agentName, searchTerm)}</td>;
    case 'wallet':
      return <td key={key} className={base}><WalletBadge wallet={row.wallet}>{highlightMatch(row.wallet, searchTerm)}</WalletBadge></td>;
    case 'amount':
      // Normal weight, not bold — this is a single row's own amount, not a
      // total/sum. Bold is reserved for genuine totals (e.g. the stat bar's
      // Total Amount above), per explicit instruction.
      return <td key={key} className={`${base} tabular-nums`}>{highlightMatch(displayNum(row.amount), searchTerm)}</td>;
    case 'remarks':
      return <td key={key} title={row.remarks} className={base}>{highlightMatch(row.remarks, searchTerm)}</td>;
    case 'date':
      return <td key={key} className={base}>{highlightMatch(formatDateDisplay(row.date), searchTerm)}</td>;
    case 'actions':
      // Flex goes on an inner span, not the <td> itself — overriding a real
      // table cell's own display away from table-cell risks breaking the
      // colgroup's table-fixed column sizing.
      // py-[2px] (not the shared py-[6px]) — a real <tr>'s `height` is only
      // a CSS minimum, not a cap, so the 32px kebab button needs tight
      // padding here to actually fit inside the target 36px row instead of
      // silently forcing every row taller (confirmed via live measurement).
      return <td key={key} className={`${cellCls} py-[2px]`}><span className="flex items-center justify-center"><RowActionsCell row={row} onEdit={onEdit} onDelete={onDelete} /></span></td>;
    default:
      return null;
  }
}

// Widths chosen from measuring the REAL rendered table (Puppeteer, Range-
// based text-width against each cell's own box), not guessed — see Cashout
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
  // KPI row's total/count/previous-period-baseline — resolved server-side
  // by transactionPageService.ts's getSettlementPageData for whichever
  // [from, to] range is currently applied (see dateRange below).
  const [kpiStats, setKpiStats] = useState<SettlementKpiStats>(EMPTY_KPI_STATS);
  // null until the first fetch resolves — server always returns its own
  // resolved {from, to, today} (Effective Today-anchored, see
  // getEffectiveBusinessToday), which becomes the source of truth here
  // rather than this page computing "today" itself.
  const [dateRange, setDateRange] = useState<DateRangeValue | null>(null);
  const [today, setToday] = useState<string>('');
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  // fetchData stays a stable (deps: []) callback like every other handler
  // on this page, but still needs the LATEST applied range on every call
  // (Refresh re-fetches the CURRENT range, not always "today") — a ref
  // avoids the stale-closure problem without making fetchData's identity
  // churn on every range change (which would otherwise re-trigger the
  // mount effect below).
  const dateRangeRef = useRef<DateRangeValue | null>(null);
  useEffect(() => { dateRangeRef.current = dateRange; }, [dateRange]);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
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
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const refreshTooltip = useTooltip(refreshButtonRef);
  const exportTooltip = useTooltip(exportButtonRef);
  const columnsTooltip = useTooltip(columnsButtonRef);
  const uploadTooltip = useTooltip(uploadButtonRef);
  const newTooltip = useTooltip(newButtonRef);

  // Row Actions -> Edit. Holds the row being edited; null means the modal
  // is closed.
  const [editingRow, setEditingRow] = useState<StlmRow | null>(null);
  // Phase 7 — Row Actions -> Delete, second-confirmation dialog.
  const [deletingRow, setDeletingRow] = useState<StlmRow | null>(null);
  // "+ Add" dropdown -> New Record / Bulk Import.
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

  // Live column widths, recomputed from the scroll container's own rendered
  // width — see computeColumnWidthsPx above. Initial value (before the
  // first measurement) uses the table's own min-width floor as a
  // reasonable SSR-safe default.
  const [colWidthsPx, setColWidthsPx] = useState<Record<ColumnKey, number>>(
    () => computeColumnWidthsPx(TABLE_MIN_WIDTH_PX - 44)
  );

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      setIsScrolled(el.scrollTop > 0);
      setAtScrollStart(el.scrollLeft <= 1);
      setAtScrollEnd(el.scrollLeft >= el.scrollWidth - el.offsetWidth - 1);
      setColWidthsPx(computeColumnWidthsPx(Math.max(el.clientWidth, TABLE_MIN_WIDTH_PX) - 44));
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

  // Phase 7 — PostgreSQL is now the unconditional runtime source. Brand and
  // Leader arrive already resolved (agents.brand_id/leader_id, the same
  // canonical join Today's Opening/Agent Balance use) — no more
  // wallet-name-segment brand parsing needed client-side;
  // transactionPageService.ts already did that server-side (same resolution
  // scripts/migrate-data.ts uses to populate agents.brand_id).
  // agents.agent_code for Send Money is already the bare (suffix-stripped)
  // name — the same form stripAgentNameSuffix used to produce — since that's
  // the exact key importWalletTransactions() matched rows against.
  const fetchData = useCallback(async (rangeOverride?: DateRangeValue) => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const range = rangeOverride ?? dateRangeRef.current;
      const rangeParams = range ? `&from=${range.from}&to=${range.to}` : '';
      const [res, openingRes, availableRes] = await Promise.all([
        fetch(`/api/v2/sendmoney/settlement?t=${Date.now()}${rangeParams}`),
        fetch(`/api/v2/sendmoney/opening?t=${Date.now()}`),
        fetch(`/api/v2/sendmoney/settlement/available-dates?t=${Date.now()}`),
      ]);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Request failed with status ${res.status}`);
      }
      const data: {
        rows: { id: number; agentName: string; amount: string; remarks: string; date: string; wallet: string; brand: string; leader: string }[];
        total: number; count: number; previousPeriodTotal: number; previousPeriodCount: number;
        today: string; from: string; to: string;
      } = await res.json();
      const stlm: StlmRow[] = data.rows.map((r) => ({
        agentName: r.agentName,
        amount: r.amount,
        remarks: r.remarks,
        date: r.date,
        wallet: r.wallet,
        brand: r.brand,
        leader: r.leader,
        _id: r.id,
      }));

      // Roster for Add/Edit's Agent Name combobox and Bulk Import's
      // validation — /api/v2/sendmoney/opening is Today's Opening's own
      // already-migrated Postgres read (consumed here read-only).
      if (openingRes.ok) {
        const openingRows: { agentCode: string }[] = await openingRes.json();
        const names = Array.from(new Set(openingRows.map((r) => r.agentCode.toUpperCase()))).sort((a, b) => a.localeCompare(b));
        setOpeningAgentNames(names);
      }
      if (availableRes.ok) {
        const { dates } = await availableRes.json();
        setAvailableDates(dates);
      }

      const validStlm = stlm.filter(row => row.agentName && row.agentName !== '-' && row.agentName !== '0');

      setStlmRows(validStlm);
      // A fresh fetch means brand-new row objects — any previous selection
      // may point at ids no longer present (e.g. after a Delete).
      setSelectedIds(new Set());
      setKpiStats({
        total: data.total,
        count: data.count,
        previousPeriodTotal: data.previousPeriodTotal,
        previousPeriodCount: data.previousPeriodCount,
      });
      setToday(data.today);
      setDateRange({ from: data.from, to: data.to });
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

  // Phase 10 — real brands table, replacing the old hardcoded
  // SETTLEMENT_BRAND_OPTIONS+'SH' array for the Bulk Import modal's own
  // Brand validation.
  const [uploadBrandOptions, setUploadBrandOptions] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/v2/brands?product=sendmoney')
      .then((res) => (res.ok ? res.json() : []))
      .then((brands: { code: string }[]) => setUploadBrandOptions(brands.map((b) => b.code)))
      .catch(() => {});
  }, []);

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

  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );
  const columnVisibility = useMemo(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, col.visible])) as Record<ColumnKey, boolean>,
    [columnDefs]
  );

  const searchedRows = stlmRows.filter((row) => {
    const haystack = `${row.agentName} ${row.amount} ${row.remarks} ${row.date} ${row.wallet} ${row.brand} ${row.leader}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  // Toolbar filters — Brand/Leader/Wallet, same shape/behavior as Balance
  // (app/agentbal/page.tsx): options are the full universe of values seen in
  // stlmRows, faceted counts below narrow per-dropdown, and filteredRows is
  // the one that actually gates the table.
  const brandOptions = useMemo(
    () => Array.from(new Set(stlmRows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [stlmRows]
  );
  const leaderOptions = useMemo(
    () => Array.from(new Set(stlmRows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [stlmRows]
  );
  const walletOptions = useMemo(
    () => Array.from(new Set(stlmRows.map((row) => row.wallet).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [stlmRows]
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
    return brandOptions.map((name) => ({ value: name, label: displayBrand(name), count: counts.get(name) ?? 0 }));
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
      const getValue = (row: StlmRow) => {
        switch (sortColumn) {
          case 'brand':
            return displayBrand(row.brand).toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
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
  }, [filteredRows, sortColumn, sortDirection]);

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

  // Phase 7 — shared by Single Edit and Bulk Edit, same one-endpoint,
  // one-transaction, all-or-nothing pattern as Today's Opening's
  // updateOpeningAgents.
  const patchSettlementRows = useCallback(async (ids: number[], updates: Record<string, string>) => {
    const res = await fetch('/api/v2/sendmoney/settlement', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, updates }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Update failed.');
    await fetchData();
  }, [fetchData]);

  const handleEditSave = useCallback(async (values: Record<string, string>) => {
    if (!editingRow) return;
    await patchSettlementRows([editingRow._id], {
      agentName: values.agentName,
      wallet: values.wallet,
      amount: values.amount,
      remarks: values.remarks ?? '',
      date: parseDisplayDateToStorage(values.date),
    });
    setEditingRow(null);
  }, [editingRow, patchSettlementRows]);

  const handleCreateSave = useCallback(async (values: Record<string, string>) => {
    const res = await fetch('/api/v2/sendmoney/settlement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: values.agentName,
        wallet: values.wallet,
        amount: values.amount,
        remarks: values.remarks ?? '',
        date: parseDisplayDateToStorage(values.date),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Create failed.');
    await fetchData();
    setNewRecordOpen(false);
  }, [fetchData]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingRow) return;
    const res = await fetch('/api/v2/sendmoney/settlement', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deletingRow._id }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Delete failed.');
    await fetchData();
    setDeletingRow(null);
  }, [deletingRow, fetchData]);

  const handleBulkEditApply = useCallback(async (updates: BulkEditUpdates) => {
    const payload: Record<string, string> = {};
    if (updates.wallet !== undefined) payload.wallet = updates.wallet;
    if (updates.remarks !== undefined) payload.remarks = updates.remarks;
    if (updates.date !== undefined) payload.date = parseDisplayDateToStorage(updates.date);
    await patchSettlementRows(Array.from(selectedIds), payload);
    setBulkEditOpen(false);
    setSelectedIds(new Set());
  }, [selectedIds, patchSettlementRows]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const settlementRecordFields: RecordFormField[] = useMemo(() => [
    // 'SH' appended locally — see app/stlm/page.tsx's identical fix for the
    // full rationale (Brand is never submitted, so this only prevents a
    // valid real value from wrongly blocking Save).
    { key: 'brand', label: 'Brand', kind: 'combobox', options: [...SETTLEMENT_BRAND_OPTIONS, 'SH'], required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: openingAgentNames, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: SENDMONEY_WALLET_OPTIONS, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'remarks', label: 'Type', kind: 'combobox', options: SETTLEMENT_REMARKS_SUGGESTIONS, allowCustom: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [openingAgentNames]);

  // Optional `rowsOverride`/`fileTag` let the Bulk Actions dropdown's own
  // "Export Selected" reuse this same export path against just the
  // checked rows, instead of duplicating the worksheet-building logic.
  const handleExport = useCallback((rowsOverride?: StlmRow[], fileTag: string = 'SETTLEMENT') => {
    const getExportValue = (row: StlmRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return displayBrand(row.brand);
        case 'leader':
          return row.leader;
        case 'agentName':
          return row.agentName;
        case 'wallet':
          return row.wallet;
        case 'amount':
          return exportNum(row.amount);
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
    const data = (rowsOverride ?? sortedRows).map((row) => exportColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Settlement');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_${fileTag}_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const handleExportSelected = useCallback(() => {
    const selectedRows = sortedRows.filter((row) => selectedIds.has(row._id));
    handleExport(selectedRows, 'SETTLEMENT_SELECTED');
  }, [sortedRows, selectedIds, handleExport]);

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
  // Compact horizontal stat bar — replaces the earlier 4-card icon KPI row
  // (too much empty space for how little each one held), matching Cashout
  // Settlement's own redesign (app/stlm/page.tsx) exactly. One hero stat
  // (Total Amount + full-figure subtitle + a trend chip comparing to
  // yesterday) plus Today's Count, inline in one thin row. Yesterday's
  // Total Amount is no longer shown at all — its value only surfaces
  // inside the delta chip. Yesterday's Count was dropped too (explicit
  // instruction).
  const amountChange = kpiStats.total - kpiStats.previousPeriodTotal;
  const amountTrend: 'up' | 'down' | 'flat' = amountChange > 0 ? 'up' : amountChange < 0 ? 'down' : 'flat';
  const isTodayRange = !!dateRange && !!today && presetOf(dateRange, today) === 'today';
  const heroKpi = useMemo(() => ({
    label: 'Total Amount',
    bigValue: fmtAbbrev(kpiStats.total),
    subtitle: fmt(kpiStats.total),
  }), [kpiStats]);
  const todayCountKpi = useMemo(() => ({
    label: isTodayRange ? "Today's Count" : 'Count',
    bigValue: kpiStats.count.toLocaleString('en-US'),
  }), [kpiStats, isTodayRange]);

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
    <div className={`settlement-page h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#0A0C11] ${manrope.variable} ${spaceGrotesk.variable}`}>
      {/* Page-scoped font override (Manrope/Space Grotesk, matching Daily
          Txn Entry's own treatment) — cascades down through SettlementHeader
          too even though that component is shared/universal, since it sets
          no font-family of its own. Every other page using SettlementHeader
          stays on Inter, unaffected. */}
      <style>{`
        .settlement-page {
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .settlement-page .tabular-nums {
          font-family: var(--font-space-grotesk), ui-monospace, monospace;
        }
      `}</style>
      <SettlementHeader
        icon={ArrowLeftRight}
        title="Settlement"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />
      {/* px-4 md:px-[28px] + the inner mx-auto max-w-[1400px] wrapper (no
          padding of its own) copies Daily Txn Entry's own <main> classes
          and nesting order exactly (app/daily-txn-entry/page.tsx), matching
          Top Up (app/topup/page.tsx) — same container size/placement. */}
      <main className="flex-1 flex flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col min-h-0">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            {/* Compact horizontal stat bar — now lives INSIDE the same
                bordered card as the toolbar/table (was previously a
                separate full-width band above <main>), matching Top Up's
                own merged-container pattern (app/topup/page.tsx) exactly. */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-border px-[13px] py-[10px]">
              {loading ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-20 dt-skeleton rounded-md" />
                    <div className="h-4 w-16 dt-skeleton rounded-md" />
                    <div className="h-4 w-24 dt-skeleton rounded-md" />
                  </div>
                  <div className="flex items-center gap-2 border-l border-border pl-6">
                    <div className="h-2.5 w-16 dt-skeleton rounded-md" />
                    <div className="h-4 w-8 dt-skeleton rounded-md" />
                  </div>
                  <div className="flex-1" />
                  <div className="h-6 w-24 dt-skeleton rounded-md" />
                </>
              ) : (
                <>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{heroKpi.label}</span>
                    <FadeValue value={heroKpi.bigValue} className="shrink-0 text-[17px] font-semibold tabular-nums text-foreground" />
                    <span className="truncate text-[11px] tabular-nums text-muted-foreground">({heroKpi.subtitle})</span>
                    {amountTrend === 'flat' ? (
                      <span className="inline-flex w-fit shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-[3px] text-[10.5px] tabular-nums text-muted-foreground">
                        No change
                      </span>
                    ) : (
                      <span className={`inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[10.5px] tabular-nums ${
                        amountTrend === 'up'
                          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                          : 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400'
                      }`}>
                        {amountTrend === 'up' ? '▲' : '▼'} {fmt(Math.abs(amountChange))} {dateRange && today ? deltaVsLabel(dateRange, today) : 'vs yesterday'}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-baseline gap-2 border-l border-border pl-6">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{todayCountKpi.label}</span>
                    <FadeValue value={todayCountKpi.bigValue} className="text-[14px] font-semibold tabular-nums text-foreground" />
                  </div>
                  <div className="flex-1" />
                  {dateRange && today && (
                    <DateRangeFilter
                      mode="picker"
                      value={dateRange}
                      availableDates={availableDates}
                      today={today}
                      onApply={(next) => fetchData(next)}
                    />
                  )}
                </>
              )}
            </div>
            {/* Same style/arrangement as Cashout Balance (app/agentbal/page.tsx):
                Filters (mr-3) -> Search (flex-1, rounded-full) -> Actions
                (ml-3), replacing the old Toolbar/Toolbar.Left/Toolbar.Right
                layout. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-border px-[13px] py-[10px]">
              {loading ? (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[80px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[83px]" />
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

              <div className="flex h-8 flex-1 min-w-[200px] items-center gap-[6px] rounded-full border border-border bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:bg-[#12151D]">
                {loading ? (
                  <div className="dt-skeleton h-[10px] w-32 rounded-md" />
                ) : (
                  <>
                    <Search size={13} className="shrink-0 text-muted-foreground" />
                    <input
                      aria-label="Search shops or brands"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[11px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                      placeholder="Search shops or brands..."
                    />
                  </>
                )}
              </div>

              {/* Selection indicator + Bulk Actions — an ADDED segment, never
                  a replacement. New/Upload/Export/Refresh/Columns below stay
                  exactly where they are whether or not anything is selected,
                  per the standard bulk-selection toolbar spec (no layout
                  shift, no hidden primary actions). */}
              {!loading && selectionBarRendered && (
                <div className="ml-[10px] flex shrink-0 items-center">
                  <BulkActionsMenu
                    count={selectedIds.size}
                    onBulkEdit={() => setBulkEditOpen(true)}
                    onExportSelected={handleExportSelected}
                    onClearSelection={() => setSelectedIds(new Set())}
                  />
                </div>
              )}

              {loading ? (
                <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[70px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[82px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                </div>
              ) : (
                <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="relative">
                    <button type="button" ref={newButtonRef} onClick={() => setNewRecordOpen(true)} aria-label="New" {...newTooltip.handlers} className={NEW_BUTTON}>
                      <Plus size={13} />
                      <span className="hidden xl:inline">New</span>
                    </button>
                    {newTooltip.rendered && <Tooltip label="New" open={newTooltip.open} pos={newTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={uploadButtonRef} onClick={() => setBulkImportOpen(true)} aria-label="Upload" {...uploadTooltip.handlers} className={ICON_BUTTON}>
                      <Upload size={13} />
                      <span className="hidden xl:inline">Upload</span>
                    </button>
                    {uploadTooltip.rendered && <Tooltip label="Upload" open={uploadTooltip.open} pos={uploadTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={() => handleExport()} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={13} />
                      <span className="hidden xl:inline">Export</span>
                    </button>
                    {exportTooltip.rendered && <Tooltip label="Export" open={exportTooltip.open} pos={exportTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={refreshButtonRef} onClick={() => fetchData()} aria-label="Refresh Data" {...refreshTooltip.handlers} className={REFRESH_ICON_BUTTON}>
                      <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
                    </button>
                    {refreshTooltip.rendered && <Tooltip label="Refresh Data" open={refreshTooltip.open} pos={refreshTooltip.pos} />}
                  </div>
                  <div className="relative">
                    <button
                      type="button"
                      ref={columnsButtonRef}
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="sendmoney-settlement-columns-popover"
                      aria-label="Customize Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={13} />
                    </button>
                    {columnsTooltip.rendered && <Tooltip label="Customize Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} />}
                    <ColumnsDropdown
                      id="sendmoney-settlement-columns-popover"
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
            {/* 6px breathing room above the table's sticky column header —
                page-local spacer, not a change to Toolbar's own shared
                internals. Desktop only, matching the table header this is
                separating from; the mobile card list below has no such
                header to separate from. */}
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
            {/* Overlay, not in-flow — centers on this outer (bounded,
                non-scrolling) container instead of the table's own
                horizontally-scrollable content width. */}
            {loading && <TableLoadingSpinner overlay />}
            <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-sm" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  <col style={{ width: '44px' }} />
                  {/* colWidthsPx already has 44px reserved for the checkbox
                      column above (see computeColumnWidthsPx's
                      `availableWidth` param, passed as
                      clientWidth - 44) — no per-column calc() needed, each
                      column just gets its own computed px width directly,
                      same as Cashout's real flex row where the checkbox is
                      a separate fixed sibling. */}
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: `${colWidthsPx[col.key]}px` }} />
                  ))}
                </colgroup>
                <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#0E1119] border-b border-[#E2E8F0] dark:border-[#262B38] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[32px]">
                    <th style={{ width: '44px' }} className="px-0 text-[12px] font-semibold text-[#475569] dark:text-[#9CA3AF]">
                      <div className="flex items-center justify-center">
                        {loading ? (
                          <div className="h-[11px] w-[11px] dt-skeleton rounded" />
                        ) : (
                          <input
                            type="checkbox"
                            aria-label="Select all rows on this page"
                            checked={allOnPageSelected}
                            onChange={toggleSelectAllOnPage}
                            className="h-[11px] w-[11px] cursor-pointer"
                          />
                        )}
                      </div>
                    </th>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: `${colWidthsPx[col.key]}px` }}
                        className={headerCellClasses(col.align, col.align === 'right' ? 'pl-[8px] pr-[28px]' : 'px-[8px]')}>
                        {/* Header shimmers along with the body during
                            loading, per explicit instruction — reverses the
                            earlier "headers are never placeholders" spec. */}
                        {loading ? (
                          <div
                            className={`h-[10px] w-3/5 max-w-[58px] dt-skeleton rounded-md ${
                              col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''
                            }`}
                          />
                        ) : !col.sortable ? (
                          // normal-case override: browsers reset
                          // text-transform to none on <button> by default,
                          // so every OTHER (sortable) header already loses
                          // the inherited `uppercase` from headerCellClasses
                          // and falls back to its label's own literal case
                          // ("Brand", not "BRAND"). This plain <span> has no
                          // such reset, so it would otherwise be the only
                          // header actually rendering uppercase ("ACTION")
                          // — this keeps it visually matching the rest.
                          <span className="normal-case">{col.label}</span>
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
                            className={`relative flex w-full items-center gap-1.5 text-${col.align} transition-[opacity,transform] duration-150 ease-[var(--ease-out-strong)] hover:opacity-80 active:scale-[0.98] ${
                              col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : 'justify-start'
                            }`}
                          >
                            {col.align === 'center' || col.align === 'right' ? (
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
                  {loading ? (
                    // Empty — the loading indicator is the overlay spinner
                    // on the outer container above, not row content here.
                    null
                  ) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    // Row height (h-[36px]), border color (border-[#ECEFF3]/
                    // dark:border-[#1A1E29]), and hover fill (hover:bg-black/
                    // [0.02]) copied verbatim from Cashout Settlement's own
                    // body row.
                    const isChecked = selectedIds.has(row._id);
                    return (
                      <tr
                        key={i}
                        aria-selected={isChecked}
                        className={`dt-row-stagger-in h-[36px] border-b border-[#ECEFF3] last:border-0 dark:border-[#1A1E29] transition-colors duration-150 ease-out ${
                          isChecked
                            ? 'bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.12)]'
                            : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.025]'
                        }`}
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                      >
                        <td>
                          <div className="flex items-center justify-center">
                            <input
                              type="checkbox"
                              aria-label={`Select row for ${row.agentName}`}
                              checked={isChecked}
                              onChange={() => toggleRowSelection(row._id)}
                              className="h-[11px] w-[11px] cursor-pointer"
                            />
                          </div>
                        </td>
                        {visibleColumns.map((col) => renderCell(row, col.key, setEditingRow, setDeletingRow, searchTerm))}
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
                  <TableLoadingSpinner minHeight={8 * 78} />
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => (
                    <div
                      key={i}
                      className="dt-row-stagger-in rounded-xl border border-border bg-white p-3.5 dark:bg-[#12151D]"
                      style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{displayBrand(row.brand)} · {row.wallet}{row.leader && row.leader !== '−' ? ` · ${toProperCase(row.leader)}` : ''}</p>
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
              <CompactTableFooter
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
        </div>
      </main>

      <RecordFormModal
        isOpen={editingRow !== null}
        onClose={() => setEditingRow(null)}
        onSave={handleEditSave}
        title="Edit Settlement Record"
        subtitle="Brand follows the agent automatically and can't be changed here."
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
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        onSave={handleCreateSave}
        title="New Settlement Record"
        fields={settlementRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onImported={fetchData}
        importApiBasePath="/api/v2/import/settlement"
        product="sendmoney"
        moduleLabel="Settlement Records"
        templateModule="settlement"
        accentButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
        brandOptions={uploadBrandOptions}
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
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <ConfirmDeleteModal
        isOpen={deletingRow !== null}
        onClose={() => setDeletingRow(null)}
        onConfirm={handleConfirmDelete}
        title="Delete Settlement Record"
        subject={deletingRow ? `${deletingRow.agentName.toUpperCase()}'s ${displayNum(deletingRow.amount)} settlement on ${formatDateDisplay(deletingRow.date)}` : ''}
        primaryButtonClassName="bg-rose-600 hover:bg-rose-700"
        dataProduct="sendmoney"
      />
    </div>
  );
}
