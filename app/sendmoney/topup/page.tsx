'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronUp, ChevronDown, ChevronsUpDown, Columns3, Download, PlusCircle, RefreshCw, MoreVertical, Copy, Pencil, Eye, Trash2, Inbox, Hash, Banknote, Tag, User, Wallet as WalletIcon, FilterX, Upload, Plus, CheckSquare, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import FilterDropdown from '@/app/components/FilterDropdown';
import ColumnsDropdown from '@/app/components/ColumnsDropdown';
import DataTable from '@/app/components/DataTable';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import RecordFormModal, { type RecordFormField } from '@/app/components/RecordFormModal';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';
import BulkImportModal from '@/app/components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '@/app/components/BulkEditModal';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { displayNum, parseAmount, fmtAbbrev, fmt } from '@/app/lib/format';
import { isToday, isYesterday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';
import { SETTLEMENT_BRAND_OPTIONS, SENDMONEY_WALLET_OPTIONS, TOPUP_TYPE_OPTIONS } from '@/app/lib/topupOptions';

function matchOptionCaseInsensitive(value: string, options: string[]): string {
  return options.find((option) => option.toLowerCase() === value.toLowerCase()) ?? value;
}

// Responsive action buttons (Refresh/Export/Columns) — icon+text when the
// viewport has room, collapsing to icon-only (40x40, no padding) once space
// gets tight. Copied verbatim from Balance (app/agentbal/page.tsx) so this
// page's toolbar matches its style/arrangement exactly, per explicit
// instruction.
const ICON_BUTTON =
  'flex h-10 w-10 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-1.5 rounded-[12px] border border-[#E2E8F0] bg-white px-0 xl:px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label, unlike ICON_BUTTON's
// xl: breakpoint reveal) — Refresh/Columns per explicit instruction, tooltip
// carries the label instead.
const ICON_ONLY_BUTTON =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-white text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Same shell as ICON_ONLY_BUTTON, indigo text/icon instead of slate —
// Refresh only, per explicit instruction; Columns stays neutral.
const REFRESH_ICON_BUTTON =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-white text-[13px] font-medium text-indigo-600 transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-indigo-400 dark:hover:bg-white/5';

// Same shell as ICON_BUTTON — border, white bg, hover/active treatment all
// identical — with only the text/icon color swapped to indigo. Kept the
// SAME indigo as Cashout (not Send Money's own teal --product-accent)
// per explicit instruction: selected-row/Bulk Actions/New should read
// identically across both products, not per-product themed. Replaces the
// old solid-fill "+ Add" button: no more filled CTA, just a colored label
// on the same neutral button shell as Refresh/Export/Columns.
const NEW_BUTTON =
  'flex h-10 w-10 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-1.5 rounded-[12px] border border-[#E2E8F0] bg-white px-0 xl:px-3 text-[13px] font-medium text-indigo-600 transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-indigo-400 dark:hover:bg-white/5';

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
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <CheckSquare size={15} className="text-indigo-600 dark:text-indigo-400" />
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
          className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-indigo-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
        >
          Bulk Actions
          <ChevronDown size={14} className={`transition-transform duration-150 ease-[var(--ease-in-out-strong)] ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && typeof document !== 'undefined' && createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="z-[9999] w-48 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
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
            <div className="my-1 border-t border-[#F1F5F9] dark:border-[#2f2f32]" />
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

const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-[color:var(--product-accent)] px-4 text-[13px] font-medium text-white transition-colors hover:opacity-90';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

type TopUpKpiStats = {
  todayCount: number;
  todayAmount: number;
  yesterdayCount: number;
  yesterdayAmount: number;
};

const EMPTY_KPI_STATS: TopUpKpiStats = { todayCount: 0, todayAmount: 0, yesterdayCount: 0, yesterdayAmount: 0 };

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

// Phase 7 — brand/agent-name resolution (parsing the wallet-name segments)
// moved server-side: transactionPageService.ts now returns each row's brand
// pre-resolved via agents.brand_id and agentName already in its bare
// (suffix-stripped) form, straight off agents.agent_code. displayBrand is
// still needed for the resolved code's own display label (e.g.
// 'SH' -> 'Sharing').
const BRAND_DISPLAY_LABELS: Record<string, string> = { SH: 'Sharing' };

function displayBrand(code: string): string {
  return BRAND_DISPLAY_LABELS[code] ?? code;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display-only reformat of the raw "M/D/YYYY" sheet value into "Jul 21,
// 2026" — copied verbatim from Settlement (app/stlm/page.tsx and
// app/sendmoney/settlement/page.tsx) so Date reads identically everywhere.
// This page previously showed the raw "7/23/2026" string directly; the
// reformat is presentational only, isToday()/sorting/search still key off
// the raw row.date.
function formatDateDisplay(dateStr: string): string {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
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
  // StlmRow._id.
  _id: number;
};

// Re-triggers a short opacity+translateY fade whenever `value` changes,
// matching Cashout Top Up's own (app/topup/page.tsx) bespoke FadeValue —
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
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

// Alignment matches Send Money Settlement (app/sendmoney/settlement/page.tsx)
// and Cashout Top Up: text left, badge/short-enum columns center, dates
// right, actions center. Leader has no Settlement equivalent — plain text
// label, left like Agent Name.
const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.TYPE, label: 'Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.key, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyTopUpColumnVisibility';

// Column sizing now matches Send Money Settlement's own arrangement exactly
// (app/sendmoney/settlement/page.tsx's CASHOUT_COLUMN_SIZING +
// computeColumnWidthsPx) — by explicit instruction, Top Up and Settlement
// share the same 8 columns and should render with the same proportions.
// minWidth/preferredWidth values below are copied verbatim from Settlement
// (itself copied from Cashout Settlement's real flex row — see that file's
// own extensive sizing notes). Type (Settlement's own Remarks-turned-Type
// column) stays pinned to its own preferredWidth; every other column shares
// any leftover space equally.
const COLUMN_SIZING: Record<ColumnKey, { minWidth: number; preferredWidth: number; grow: boolean }> = {
  brand: { minWidth: 90, preferredWidth: 149, grow: true },
  leader: { minWidth: 100, preferredWidth: 150, grow: true },
  agentName: { minWidth: 140, preferredWidth: 216, grow: true },
  wallet: { minWidth: 90, preferredWidth: 208, grow: true },
  amount: { minWidth: 115, preferredWidth: 244, grow: true },
  type: { minWidth: 160, preferredWidth: 243, grow: false },
  date: { minWidth: 110, preferredWidth: 149, grow: true },
  actions: { minWidth: 56, preferredWidth: 109, grow: true },
};

// The 44px checkbox <col> is a separate fixed-width sibling, never a slice
// out of Brand's own share. `availableWidth` passed in must already have 44
// subtracted so the 7 data columns split exactly what's left.
function computeColumnWidthsPx(availableWidth: number): Record<ColumnKey, number> {
  const entries = (Object.keys(COLUMN_SIZING) as ColumnKey[]).map((key) => ({
    key,
    ...COLUMN_SIZING[key],
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

// Table's own floor — matches Settlement's summed minWidth (861px) plus the
// 44px checkbox column, so this page's horizontal-scroll fallback engages
// at the same point Settlement's own does.
const TABLE_MIN_WIDTH_PX = 861 + 44;

function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-4') {
  return `group ${paddingCls} text-[14px] leading-[20px] font-semibold text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap text-${align}`;
}

// Copied verbatim from Cashout Top Up's own toProperCase — the sheet's raw
// Type value is ALL CAPS ("INTERNAL TRANSFER"), formal-cased for display.
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
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
// (possibly search-highlighted, display-relabeled) content, which can
// differ from the raw string.
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

// Row actions menu (⋮) — copied from Settlement (app/stlm/page.tsx /
// app/sendmoney/settlement/page.tsx). Edit and Delete are both real
// PostgreSQL mutations as of Phase 7; View Details stays a disabled
// placeholder (no detail view exists yet).
function RowActionsCell({ row, onEdit, onDelete }: { row: TopUpRow; onEdit: (row: TopUpRow) => void; onDelete: (row: TopUpRow) => void }) {
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
      `Type: ${row.type}`,
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

const AGENT_NAME_SKELETON_WIDTHS = [55, 70, 85];
const TYPE_SKELETON_WIDTHS = [50, 65, 80];
const AMOUNT_SKELETON_WIDTHS = [26, 30, 24, 28];
const WALLET_SKELETON_WIDTHS = [48, 60, 52, 56];

function renderSkeletonCell(col: ColumnDef, rowIndex: number) {
  switch (col.key) {
    case 'brand':
      return (
        <td key={col.key} className="px-4 py-3">
          <div className="dt-skeleton h-[28px] w-9 rounded-full" />
        </td>
      );
    case 'leader':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div className="dt-skeleton h-3 w-2/3 rounded-md" />
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
    case 'type':
      return (
        <td key={col.key} className="px-4 py-[14px]">
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${TYPE_SKELETON_WIDTHS[rowIndex % TYPE_SKELETON_WIDTHS.length]}%` }}
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
      return (
        <td key={col.key} className="px-4 py-2.5">
          <div className="dt-skeleton h-8 w-8 rounded-[8px] mx-auto" />
        </td>
      );
    default:
      return null;
  }
}

function renderCell(row: TopUpRow, key: ColumnKey, onEdit: (row: TopUpRow) => void, onDelete: (row: TopUpRow) => void, searchTerm: string) {
  const truncates = key === COLUMN_IDS.AGENT_NAME;
  const cellCls = `whitespace-nowrap ${truncates ? 'overflow-hidden text-ellipsis' : ''} px-4 text-${COLUMN_ALIGN[key]} text-[13px] leading-[20px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  const base = `${cellCls} py-[14px]`;
  switch (key) {
    case 'brand':
      return <td key={key} className={`${cellCls} py-3`}><BrandBadge brand={row.brand}>{highlightMatch(displayBrand(row.brand), searchTerm)}</BrandBadge></td>;
    case 'leader': {
      const leaderText = row.leader && row.leader !== '-' ? toProperCase(row.leader) : '−';
      return <td key={key} title={leaderText} className={base}>{highlightMatch(leaderText, searchTerm)}</td>;
    }
    case 'agentName':
      return <td key={key} title={row.agentName} className={base}>{highlightMatch(row.agentName, searchTerm)}</td>;
    case 'wallet':
      return <td key={key} className={base}><WalletBadge wallet={row.wallet}>{highlightMatch(row.wallet, searchTerm)}</WalletBadge></td>;
    case 'amount':
      return <td key={key} className={`${base} !text-[12px] font-semibold tabular-nums`}>{highlightMatch(displayNum(row.amount), searchTerm)}</td>;
    case 'type': {
      const typeText = row.type && row.type !== '-' ? toProperCase(row.type) : '−';
      return <td key={key} title={typeText} className={base}>{highlightMatch(typeText, searchTerm)}</td>;
    }
    case 'date':
      return <td key={key} className={base}>{highlightMatch(formatDateDisplay(row.date), searchTerm)}</td>;
    case 'actions':
      return <td key={key} className={`${cellCls} py-2.5`}><span className="flex items-center justify-center"><RowActionsCell row={row} onEdit={onEdit} onDelete={onDelete} /></span></td>;
    default:
      return null;
  }
}

export default function SendMoneyTopUpPage() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
  // Real Balance Shop Agent roster — collected from the same /api/opening
  // response fetchData already reads for leaderMap (col 11, "Opening AG"
  // L:O shift), not from today's Top Up rows only.
  const [openingAgentNames, setOpeningAgentNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  // SettlementSummary's KPI row — real counts/totals computed in fetchData
  // from the SAME "PS BD STLM + TOPUP" sheet the table itself reads (it
  // carries several weeks of rows, not just today's; isToday()/isYesterday()
  // narrow it down). Not derived from topUpRows itself, since that's already
  // narrowed to today only — see fetchData for the actual computation.
  const [kpiStats, setKpiStats] = useState<TopUpKpiStats>(EMPTY_KPI_STATS);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
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

  const [editingRow, setEditingRow] = useState<TopUpRow | null>(null);
  // Phase 7 — Row Actions -> Delete, second-confirmation dialog.
  const [deletingRow, setDeletingRow] = useState<TopUpRow | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  // Sticky-header scroll shadow — copied from Send Money Settlement
  // (app/sendmoney/settlement/page.tsx).
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
  // Leader arrive already resolved (agents.brand_id/leader_id) — no more
  // wallet-name-segment brand parsing needed client-side. agentName is
  // already the bare (suffix-stripped) agents.agent_code form. Type
  // ("INTERNAL TRANSFER") is a fixed literal per product, derived
  // server-side — see transactionPageService.ts's TOPUP_TYPE_LABEL.
  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [res, openingRes] = await Promise.all([
        fetch(`/api/v2/sendmoney/topup?t=${Date.now()}`),
        fetch(`/api/v2/sendmoney/opening?t=${Date.now()}`),
      ]);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Request failed with status ${res.status}`);
      }
      const topUp: TopUpRow[] = (await res.json()).map((r: { id: number; agentName: string; wallet: string; amount: string; date: string; type: string; leader: string; brand: string }) => ({
        agentName: r.agentName,
        wallet: r.wallet,
        amount: r.amount,
        date: r.date,
        type: r.type,
        leader: r.leader,
        brand: r.brand,
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

      // Split out so both the table's "today only" rows and the KPI row's
      // "today vs yesterday" comparison can be computed from one pass —
      // same pattern as app/sendmoney/settlement/page.tsx.
      const todayTopUp = topUp.filter(row => isToday(row.date));
      const yesterdayTopUp = topUp.filter(row => isYesterday(row.date));

      setTopUpRows(todayTopUp);
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

  const searchedRows = topUpRows.filter((row) => {
    const haystack = `${row.agentName} ${row.wallet} ${row.amount} ${row.date} ${row.type} ${row.leader}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  // Toolbar filters — Brand/Leader/Wallet, same shape/behavior as Balance
  // (app/agentbal/page.tsx): options are the full universe of values seen in
  // topUpRows, faceted counts below narrow per-dropdown, and filteredRows is
  // the one that actually gates the table.
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
      const getValue = (row: TopUpRow) => {
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
          case 'type':
            return row.type.toLowerCase();
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

  const parseDisplayDateToStorage = (display: string): string => {
    const parsed = new Date(display);
    if (isNaN(parsed.getTime())) return display;
    return `${parsed.getMonth() + 1}/${parsed.getDate()}/${parsed.getFullYear()}`;
  };

  // Phase 7 — shared by Single Edit and Bulk Edit, same one-endpoint,
  // one-transaction, all-or-nothing pattern as Today's Opening's
  // updateOpeningAgents.
  const patchTopUpRows = useCallback(async (ids: number[], updates: Record<string, string>) => {
    const res = await fetch('/api/v2/sendmoney/topup', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, updates }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Update failed.');
    await fetchData();
  }, [fetchData]);

  // Brand stays display-only (follows the agent, never stored per-
  // transaction). Type used to be display-only too (a fixed literal per
  // product) but is now a real stored field — see
  // transactionActionsService.ts's header comment — so it's sent as
  // `remarks`, the same wire field Settlement's own Edit/Create already use.
  const handleEditSave = useCallback(async (values: Record<string, string>) => {
    if (!editingRow) return;
    await patchTopUpRows([editingRow._id], {
      agentName: values.agentName,
      wallet: values.wallet,
      amount: values.amount,
      date: parseDisplayDateToStorage(values.date),
      remarks: values.type,
    });
    setEditingRow(null);
  }, [editingRow, patchTopUpRows]);

  const handleCreateSave = useCallback(async (values: Record<string, string>) => {
    const res = await fetch('/api/v2/sendmoney/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: values.agentName,
        wallet: values.wallet,
        amount: values.amount,
        date: parseDisplayDateToStorage(values.date),
        remarks: values.type,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Create failed.');
    await fetchData();
    setNewRecordOpen(false);
  }, [fetchData]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingRow) return;
    const res = await fetch('/api/v2/sendmoney/topup', {
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
    if (updates.date !== undefined) payload.date = parseDisplayDateToStorage(updates.date);
    await patchTopUpRows(Array.from(selectedIds), payload);
    setBulkEditOpen(false);
    setSelectedIds(new Set());
  }, [selectedIds, patchTopUpRows]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  // Type is a fixed literal for Send Money Top Up ("INTERNAL TRANSFER") —
  // closed, single-option combobox (no allowCustom), matching how the row
  // is always actually populated.
  const topupRecordFields: RecordFormField[] = useMemo(() => [
    // 'SH' appended locally — see app/stlm/page.tsx's identical fix for the
    // full rationale (Brand is never submitted, so this only prevents a
    // valid real value from wrongly blocking Save).
    { key: 'brand', label: 'Brand', kind: 'combobox', options: [...SETTLEMENT_BRAND_OPTIONS, 'SH'], required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: openingAgentNames, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: SENDMONEY_WALLET_OPTIONS, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'type', label: 'Type', kind: 'combobox', options: TOPUP_TYPE_OPTIONS, required: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [openingAgentNames]);

  // Optional `rowsOverride`/`fileTag` let the Bulk Actions dropdown's own
  // "Export Selected" reuse this same export path against just the
  // checked rows, instead of duplicating the worksheet-building logic.
  const handleExport = useCallback((rowsOverride?: TopUpRow[], fileTag: string = 'TOPUP') => {
    const getExportValue = (row: TopUpRow, key: ColumnKey) => {
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
          return displayNum(row.amount);
        case 'type':
          return row.type;
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
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Top Up');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_${fileTag}_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const handleExportSelected = useCallback(() => {
    const selectedRows = sortedRows.filter((row) => selectedIds.has(row._id));
    handleExport(selectedRows, 'TOPUP_SELECTED');
  }, [sortedRows, selectedIds, handleExport]);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Balance-style KPI cards (bespoke, not SettlementSummary), matching
  // Cashout Top Up (app/topup/page.tsx) exactly. Count metrics have no
  // subtitle (would just duplicate the big value); amount metrics get an
  // abbreviated big value + full-figure subtitle.
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
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
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
            {/* Same style/arrangement as Cashout Balance (app/agentbal/page.tsx):
                Filters (mr-3) -> Search (flex-1, rounded-full) -> Actions
                (ml-3), replacing the old Toolbar/Toolbar.Left/Toolbar.Right
                layout. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-border px-4 py-3">
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

              <div className="flex h-10 flex-1 min-w-[200px] items-center gap-2 rounded-full border border-border bg-white px-[16px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:bg-[#2a2a2d]">
                {loading ? (
                  <div className="h-3 w-32 dt-skeleton rounded-md" />
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

              {/* Selection indicator + Bulk Actions — an ADDED segment, never
                  a replacement. New/Upload/Export/Refresh/Columns below stay
                  exactly where they are whether or not anything is selected,
                  per the standard bulk-selection toolbar spec (no layout
                  shift, no hidden primary actions). */}
              {!loading && selectionBarRendered && (
                <div className="ml-3 flex shrink-0 items-center">
                  <BulkActionsMenu
                    count={selectedIds.size}
                    onBulkEdit={() => setBulkEditOpen(true)}
                    onExportSelected={handleExportSelected}
                    onClearSelection={() => setSelectedIds(new Set())}
                  />
                </div>
              )}

              {loading ? (
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[88px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />
                </div>
              ) : (
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <div className="relative">
                    <button type="button" ref={newButtonRef} onClick={() => setNewRecordOpen(true)} aria-label="New" {...newTooltip.handlers} className={NEW_BUTTON}>
                      <Plus size={16} />
                      <span className="hidden xl:inline">New</span>
                    </button>
                    {newTooltip.rendered && <Tooltip label="New" open={newTooltip.open} pos={newTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={uploadButtonRef} onClick={() => setBulkImportOpen(true)} aria-label="Upload" {...uploadTooltip.handlers} className={ICON_BUTTON}>
                      <Upload size={16} />
                      <span className="hidden xl:inline">Upload</span>
                    </button>
                    {uploadTooltip.rendered && <Tooltip label="Upload" open={uploadTooltip.open} pos={uploadTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={() => handleExport()} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={16} />
                      <span className="hidden xl:inline">Export</span>
                    </button>
                    {exportTooltip.rendered && <Tooltip label="Export" open={exportTooltip.open} pos={exportTooltip.pos} onlyWhenCompact />}
                  </div>
                  <div className="relative">
                    <button type="button" ref={refreshButtonRef} onClick={fetchData} aria-label="Refresh Data" {...refreshTooltip.handlers} className={REFRESH_ICON_BUTTON}>
                      <RefreshCw size={16} className={spinning ? 'animate-spin' : ''} />
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
                      aria-controls="sendmoney-topup-columns-popover"
                      aria-label="Customize Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={16} />
                    </button>
                    {columnsTooltip.rendered && <Tooltip label="Customize Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} />}
                    <ColumnsDropdown
                      id="sendmoney-topup-columns-popover"
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
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
            <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-sm" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  <col style={{ width: '44px' }} />
                  {/* colWidthsPx already has 44px reserved for the checkbox
                      column above (see computeColumnWidthsPx's
                      `availableWidth` param, passed as clientWidth - 44) —
                      no per-column calc() needed, same as
                      /sendmoney/settlement. */}
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: `${colWidthsPx[col.key]}px` }} />
                  ))}
                </colgroup>
                <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${
                  isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''
                }`}>
                  <tr className="h-[48px]">
                    <th style={{ width: '44px' }} className="px-0">
                      <div className="flex items-center justify-center">
                        {loading ? (
                          <div className="h-3.5 w-3.5 dt-skeleton rounded" />
                        ) : (
                          <input
                            type="checkbox"
                            aria-label="Select all rows on this page"
                            checked={allOnPageSelected}
                            onChange={toggleSelectAllOnPage}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        )}
                      </div>
                    </th>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: `${colWidthsPx[col.key]}px` }}
                        className={headerCellClasses(col.align, 'px-4')}>
                        {/* Header shimmers along with the body during
                            loading, per explicit instruction — reverses the
                            earlier "headers are never placeholders" spec. */}
                        {loading ? (
                          <div
                            className={`h-3 w-3/5 max-w-[72px] dt-skeleton rounded-md ${
                              col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''
                            }`}
                          />
                        ) : !col.sortable ? (
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
                            className={`relative flex w-full items-center gap-1.5 text-${col.align} transition-[opacity,transform] duration-150 ease-[var(--ease-out-strong)] hover:opacity-80 active:scale-[0.98] ${
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
                            ? 'bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.12)]'
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
                          <p className="truncate text-[12px] font-normal text-muted-foreground">{displayBrand(row.brand)} · {row.wallet}{row.leader && row.leader !== '−' ? ` · ${toProperCase(row.leader)}` : ''}</p>
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
        onSave={handleEditSave}
        title="Edit Top Up Record"
        subtitle="Brand follows the agent automatically and can't be changed here."
        fields={topupRecordFields}
        initialValues={editingRow ? {
          brand: matchOptionCaseInsensitive(editingRow.brand, SETTLEMENT_BRAND_OPTIONS),
          // Uppercase — Agent Name's canonical form is full caps, regardless
          // of how the sheet itself has it stored.
          agentName: editingRow.agentName.toUpperCase(),
          wallet: matchOptionCaseInsensitive(editingRow.wallet, SENDMONEY_WALLET_OPTIONS),
          amount: String(parseAmount(editingRow.amount)),
          type: editingRow.type,
          date: formatDateDisplay(editingRow.date),
        } : {}}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        onSave={handleCreateSave}
        title="New Top Up Record"
        fields={topupRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onImported={fetchData}
        importApiBasePath="/api/v2/import/topup"
        product="sendmoney"
        moduleLabel="Top Up Records"
        templateModule="topup"
        moduleKind="topup"
        accentButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
        brandOptions={uploadBrandOptions}
        walletOptions={SENDMONEY_WALLET_OPTIONS}
        agentRoster={openingAgentNames}
        typeOptions={TOPUP_TYPE_OPTIONS}
      />

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        walletOptions={SENDMONEY_WALLET_OPTIONS}
        primaryButtonClassName="bg-[color:var(--product-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <ConfirmDeleteModal
        isOpen={deletingRow !== null}
        onClose={() => setDeletingRow(null)}
        onConfirm={handleConfirmDelete}
        title="Delete Top Up Record"
        subject={deletingRow ? `${deletingRow.agentName.toUpperCase()}'s ${displayNum(deletingRow.amount)} top up on ${formatDateDisplay(deletingRow.date)}` : ''}
        primaryButtonClassName="bg-rose-600 hover:bg-rose-700"
        dataProduct="sendmoney"
      />
    </div>
  );
}
