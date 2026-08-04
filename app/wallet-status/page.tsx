'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, RefreshCw, Search, Flag, Check, X,
  SquarePen, Loader2, Info, FilterX, CheckSquare, Pencil, Trash2, User, ArrowDownCircle,
  ArrowUpCircle, Clock, CircleDot,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import DataTable from '../components/DataTable';
import FilterDropdown from '../components/FilterDropdown';
import ColumnsDropdown from '../components/ColumnsDropdown';
import TableFooter from '../components/TableFooter';
import EmptyState from '../components/EmptyState';
import BulkEditModal, { type BulkEditUpdates } from '../components/BulkEditModal';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '../lib/csv';
import { getBusinessToday } from '../lib/businessDate';
import { getPreference, setPreference } from '../lib/preferences';
import {
  computeCompanyBalance,
  resolveBrand,
  computeWalletStatus,
  computeBaseLimit,
  computeFrozenAmount,
  computeAvailableLimit,
} from '../lib/balanceEngine';

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
// Field names here (updatedBy/updatedAt) must match the actual API
// response shape (mergeWalletStatusAndRemarks in app/lib/walletStatus.ts)
// exactly — a prior "remarkUpdatedBy"/"remarkUpdatedAt" mismatch here
// silently produced undefined on every fresh fetch (confirmed live: the
// sheet correctly stored "Operations Admin" + a real timestamp, but a
// reload showed no "Updated by" section at all) while masking itself
// right after a Save, since that path updates row state directly from the
// POST response instead of refetching.
type PriorityEntry = { priority: Priority; remark: string; updatedBy: string; updatedAt: string };
const DEFAULT_PRIORITY_ENTRY: PriorityEntry = { priority: 'Normal', remark: '', updatedBy: '', updatedAt: '' };

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

// Format mimics Transfer Queue (app/transfer-queue/page.tsx) per explicit
// instruction — same GHOST_BUTTON toolbar, SettlementHeader, DataTable,
// native table, ColumnsDropdown, TableFooter, mobile card list. Column
// widths use Balance's own dynamic per-column measurement system (see
// computeColumnWidthsPx below) rather than colgroup/table-fixed — per
// explicit instruction to arrange sizing the same way as Balance.
// Toolbar button shells — same style/arrangement as Top Up/Settlement
// (app/topup/page.tsx, app/stlm/page.tsx), copied verbatim so this page's
// filter/search/action row matches theirs pixel-for-pixel, per explicit
// instruction. Icon+text when the viewport has room, collapsing to
// icon-only (40x40) once space gets tight.
const ICON_BUTTON =
  'flex h-10 w-10 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-1.5 rounded-[12px] border border-[#E2E8F0] bg-white px-0 xl:px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label) — Columns only.
const ICON_ONLY_BUTTON =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-white text-[13px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Same shell as ICON_ONLY_BUTTON, indigo text/icon instead of slate —
// Refresh only.
const REFRESH_ICON_BUTTON =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-white text-[13px] font-medium text-indigo-600 transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[#2563EB] hover:bg-[#F1F5F9] hover:ring-2 hover:ring-[#2563EB]/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-indigo-400 dark:hover:bg-white/5';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

// Shared hover/focus-driven tooltip state for toolbar buttons — portal
// rendered so it's never clipped by the toolbar's overflow-x-auto.
// Positions ABOVE its trigger (unlike useBelowTooltip further down this
// file, which anchors table-header info icons BELOW theirs) — copied
// verbatim from Top Up (app/topup/page.tsx), page-local by established
// project convention.
function useToolbarTooltip(triggerRef: React.RefObject<HTMLElement | null>) {
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

function ToolbarTooltip({
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

// Toolbar filter trigger — Leader/Deposit/Withdrawal/Schedule/Wallet Status.
// Trigger only; the panel beneath it is the shared FilterDropdown
// (app/components/FilterDropdown.tsx). Copied verbatim from Top Up.
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
  const tooltip = useToolbarTooltip(buttonRef);
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
          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
            {selectedCount}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`hidden text-[#475569] transition-transform duration-150 ease-[var(--ease-in-out-strong)] dark:text-[#9CA3AF] xl:inline ${menuOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {tooltip.rendered && <ToolbarTooltip label={label} open={tooltip.open} pos={tooltip.pos} onlyWhenCompact />}
    </div>
  );
}

// "Reset All Filters" trigger — filled indigo icon once a filter is active.
// Copied verbatim from Top Up.
function ResetFiltersButton({ anyFilterActive, onClick }: { anyFilterActive: boolean; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltip = useToolbarTooltip(buttonRef);

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
      {tooltip.rendered && <ToolbarTooltip label="Reset all filters" open={tooltip.open} pos={tooltip.pos} />}
    </div>
  );
}

// Bulk Actions dropdown — appears alongside (never instead of) the standard
// toolbar: Export/Refresh/Columns stay exactly where they are; this is
// purely an added segment while 1+ rows are checked. Portal-rendered, same
// click-outside-close pattern as the Columns dropdown. Copied verbatim from
// Top Up/Settlement.
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
    <div className="flex items-center gap-2">
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
            <button type="button" onClick={() => { setOpen(false); onBulkEdit(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5">
              <Pencil size={13} />
              Bulk Edit
            </button>
            <button type="button" onClick={() => { setOpen(false); onExportSelected(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5">
              <Download size={13} />
              Export Selected
            </button>
            <button type="button" disabled title="Coming soon" className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]">
              <Trash2 size={13} />
              Delete Selected
            </button>
            <div className="my-1 border-t border-[#F1F5F9] dark:border-[#2f2f32]" />
            <button type="button" onClick={() => { setOpen(false); onClearSelection(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5">
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

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// Display-only formatting — the sheet stores Leader in raw ALL CAPS
// ("ONEMEN", "MRLEE"); matching/search/schedule-lookup all stay on that
// raw value (see resolveSchedule, searchedRows), only the rendered text
// gets Title Cased so it reads as a proper name instead of shouting.
function toProperCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Fixed dropdown/sort order — Low, Normal, High (ascending urgency).
const PRIORITY_OPTIONS: Priority[] = ['Low', 'Normal', 'High'];
const PRIORITY_RANK: Record<Priority, number> = { Low: 0, Normal: 1, High: 2 };

// Schedule is never staff-entered — it's derived purely from Leader via
// SCHEDULE_GROUPS below. '' means the leader isn't in any group (renders
// as a blank cell, never "Unknown"/"N/A"/a default, per explicit spec).
type Schedule = 'Early Ext.' | 'Extended' | 'Day' | '24/7' | '';

// Single centralized mapping — add new leaders under the relevant group
// only, never hardcode a Schedule value anywhere else.
const SCHEDULE_GROUPS: Record<Exclude<Schedule, ''>, string[]> = {
  'Early Ext.': ['SHARIF', 'SHAD', 'RIDOY', 'MRLEE', 'SOHARD', 'MIR', 'SONCHOY', 'BERLIN', 'CHAK', 'LIMON', 'SHIK'],
  'Extended': ['RIPAN', 'RC', 'TAPAN', 'LEOLIZA', 'JISAN', 'MONIR', 'NIJHUM'],
  'Day': ['ROSE', 'JAVED', 'DARAZ', 'ROBI', 'SHAKIL', 'SAM', 'NURNOBY', 'MUNIM'],
  '24/7': ['DEAN', 'ALADDIN', 'RAYHAN', 'EMON', 'TANVIR'],
};

const LEADER_SCHEDULE_LOOKUP = new Map<string, Schedule>(
  Object.entries(SCHEDULE_GROUPS).flatMap(([schedule, leaders]) =>
    leaders.map((leader) => [leader, schedule as Schedule] as const)
  )
);

function resolveSchedule(leader: string): Schedule {
  return LEADER_SCHEDULE_LOOKUP.get(leader.trim().toUpperCase()) ?? '';
}

// Sort order per spec: 24/7, Day, Early Ext., Extended, then blank last —
// same rank-based approach as PRIORITY_RANK, reversible by sort direction.
const SCHEDULE_SORT_ORDER: Schedule[] = ['24/7', 'Day', 'Early Ext.', 'Extended', ''];
const SCHEDULE_RANK: Record<Schedule, number> = Object.fromEntries(
  SCHEDULE_SORT_ORDER.map((s, i) => [s, i])
) as Record<Schedule, number>;

// Fixed small domains — unlike Leader (open-ended, derived from the roster
// below), Deposit/Withdrawal/Wallet Status only ever take these values.
const DEPOSIT_WITHDRAWAL_OPTIONS: DepositWithdrawal[] = ['Yes', 'No'];
const WALLET_STATUS_FILTER_OPTIONS: WalletStatusValue[] = ['Active', 'Inactive', 'Wallet With Issue'];
const SCHEDULE_FILTER_LABEL: Record<Schedule, string> = {
  '24/7': '24/7',
  'Day': 'Day',
  'Early Ext.': 'Early Ext.',
  'Extended': 'Extended',
  '': 'No Schedule',
};

type WalletStatusRow = {
  // Sequential index assigned once at fetch time — the row-selection
  // checkbox system's only stable identity (shopName/`key` also works, but
  // matches the numeric-id convention Top Up/Settlement's own bulk
  // selection already uses).
  _id: number;
  key: string;
  shopName: string;
  brand: string;
  leader: string;
  companyBalance: number;
  baseLimit: number;
  availableLimit: number;
  frozenAmount: number;
  sdpDisplay: string;
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  priority: Priority;
  schedule: Schedule;
  walletStatus: WalletStatusValue;
  remark: string;
  remarkUpdatedBy: string;
  remarkUpdatedAt: string;
};

const COLUMN_IDS = {
  BRAND: 'brand',
  SHOP_NAME: 'shopName',
  LEADER: 'leader',
  COMPANY_BALANCE: 'companyBalance',
  AVAILABLE_LIMIT: 'availableLimit',
  FROZEN_AMOUNT: 'frozenAmount',
  SDP: 'sdp',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  PRIORITY: 'priority',
  SCHEDULE: 'schedule',
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
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.SHOP_NAME, label: 'Shop Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AVAILABLE_LIMIT, label: 'Available Limit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.FROZEN_AMOUNT, label: 'Frozen Amount', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SDP, label: 'SDP', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DEPOSIT, label: 'Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WITHDRAWAL, label: 'Withdrawal', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.PRIORITY, label: 'Priority', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SCHEDULE, label: 'Schedule', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: true, sortable: true, hideable: false, align: 'left' },
  // Independent of Wallet Status/Priority — its own click-to-edit popover,
  // not tied to the row-wide Edit/Save/Cancel below. Fixed width (see
  // computeColumnWidthsPx's own special-case), never measured from content.
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'left' },
  // Edit/Save/Cancel per ROW — Priority is the only field this saves;
  // Deposit/Withdrawal/Wallet Status are computed and read-only. Never
  // hideable — it's the only edit affordance for the row.
  { key: COLUMN_IDS.WALLET_STATUS_ACTION, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'walletStatusColumnVisibility';

// Same dynamic per-column width system as Balance (app/agentbal/page.tsx):
// every column is sized to its own longest real value across the FULL
// dataset (not just the current page), so no column ever truncates its
// header or clips a value, and pagination/sorting never makes a column
// visibly jump. table-auto (no <colgroup>/table-fixed) + inline
// width/minWidth per cell, same as Balance.
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
    case 'leader': return toProperCase(row.leader);
    case 'companyBalance': return displayNum(row.companyBalance);
    case 'availableLimit': return displayAvailableLimit(row.availableLimit);
    case 'frozenAmount': return displayNum(row.frozenAmount);
    case 'sdp': return row.sdpDisplay;
    case 'deposit': return row.deposit;
    case 'withdrawal': return row.withdrawal;
    case 'priority': return priorityDisplay(row);
    case 'schedule': return row.schedule;
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
  leader: ['w-16', 'w-20', 'w-14'],
  companyBalance: ['w-16', 'w-20', 'w-14'],
  availableLimit: ['w-16', 'w-14', 'w-20'],
  frozenAmount: ['w-14', 'w-10', 'w-16'],
  sdp: ['w-14', 'w-16', 'w-12'],
  deposit: ['w-10', 'w-10', 'w-10'],
  withdrawal: ['w-10', 'w-10', 'w-10'],
  priority: ['w-14', 'w-14', 'w-14'],
  schedule: ['w-14', 'w-16', 'w-12'],
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

// Per explicit instruction, Remarks is no longer independently
// click-to-edit — it only becomes editable when the row's own Pencil icon
// is clicked (same row-wide edit mode Priority already uses; see
// `editing`/`onChange` below, wired from RowDraft.remark). At rest, this
// is read-only: a single-line, ellipsis-truncated value (or an italic
// "Add Remark" placeholder when empty) with the full remark + attribution
// on hover via the same useBelowTooltip pattern already used by
// HeaderInfoIcon.
function RemarksCell({
  remark,
  updatedBy,
  updatedAt,
  editing,
  onChange,
}: {
  remark: string;
  updatedBy: string;
  updatedAt: string;
  editing: boolean;
  onChange?: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltip = useBelowTooltip(triggerRef, { delayMs: REMARKS_TOOLTIP_HOVER_DELAY_MS });
  const hasRemark = remark.trim() !== '';

  // The editable "container" per explicit instruction — only ever
  // rendered while this row is in edit mode; never visible otherwise.
  if (editing) {
    return (
      <textarea
        autoFocus
        maxLength={500}
        rows={2}
        value={remark}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder="Add remarks…"
        className="w-full resize-none rounded-md border border-border bg-white px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
      />
    );
  }

  return (
    <span
      ref={triggerRef}
      {...(hasRemark ? tooltip.handlers : {})}
      className="flex h-7 w-full max-w-full items-center overflow-hidden"
    >
      {hasRemark ? (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-normal text-slate-700 dark:text-slate-300">{remark}</span>
      ) : (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-normal italic text-slate-400 dark:text-slate-500">− Add Remark −</span>
      )}
      {hasRemark && tooltip.rendered && typeof document !== 'undefined' && createPortal(
        // Light "premium floating card" per spec (explicit literal hex
        // values, not the semantic dark/light theme tokens the rest of the
        // app pairs everything with) — a deliberate one-off design that
        // stays white regardless of app theme, same treatment a raised
        // info card gets in most dashboards for legibility over any
        // background. Scales in from the trigger (transform-origin: top —
        // the arrow's own anchor point) rather than a bare opacity fade,
        // starting from 0.97 (never scale(0) — Kowalski: nothing in the
        // real world pops in from nothing).
        <div
          style={{
            position: 'fixed',
            top: tooltip.pos.top,
            left: tooltip.pos.left,
            transform: `translate(-50%, 0) scale(${tooltip.open ? 1 : 0.97})`,
            transformOrigin: 'top center',
          }}
          className={`pointer-events-none z-[9999] max-w-[420px] rounded-[12px] border border-[#E5E7EB] bg-white p-4 text-left shadow-[0_10px_30px_rgba(15,23,42,0.12)] transition-[opacity,transform] duration-150 ease-out ${tooltip.open ? 'opacity-100' : 'opacity-0'}`}
        >
          <div className="text-[13px] font-semibold text-[#334155]">Remark</div>
          <div className="mt-1.5 whitespace-pre-line break-words text-[13px] font-normal leading-relaxed text-[#334155]">
            {remark}
          </div>
          {/* Two side-by-side info boxes (Last Update / Updated By) per
              explicit instruction — subtle tinted background + uppercase
              micro-label carries the "not plain" polish instead of an
              icon, matching the removal of the chat-bubble marker above. */}
          {(updatedBy || updatedAt) && (
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#E5E7EB] pt-3">
              <div className="rounded-[8px] bg-[#F8FAFC] px-2.5 py-2">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-[#94A3B8]">Last Update</p>
                <p className="mt-0.5 text-[12px] font-semibold text-[#334155]">{updatedAt ? formatRemarkTimestamp(updatedAt) : '—'}</p>
              </div>
              <div className="rounded-[8px] bg-[#F8FAFC] px-2.5 py-2">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-[#94A3B8]">Updated By</p>
                <p className="mt-0.5 text-[12px] font-semibold text-[#334155]">{updatedBy || '—'}</p>
              </div>
            </div>
          )}
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-l border-t border-[#E5E7EB] bg-white" />
        </div>,
        document.body
      )}
    </span>
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
// Remarks is now staged in the SAME row-wide draft as Priority — per
// explicit instruction, Remarks only becomes editable via the row's own
// Pencil icon (no independent click-to-edit anymore), and a single
// Save/Cancel commits or discards both fields together.
type RowDraft = { priority: Priority; remark: string };

function rowHasChanges(row: WalletStatusRow, draft: RowDraft | null): boolean {
  if (!draft) return false;
  return draft.priority !== row.priority || draft.remark !== row.remark;
}

export default function WalletStatus() {
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
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const exportTooltip = useToolbarTooltip(exportButtonRef);
  const refreshTooltip = useToolbarTooltip(refreshButtonRef);
  const columnsTooltip = useToolbarTooltip(columnsButtonRef);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Toolbar filters — Leader/Deposit/Withdrawal/Schedule/Wallet Status, same
  // shape/behavior as Top Up/Settlement's own Brand/Leader/Wallet filters:
  // absence from the map means checked, a value is only ever written
  // `false`.
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [depositFilter, setDepositFilter] = useState<Record<string, boolean>>({});
  const [withdrawalFilter, setWithdrawalFilter] = useState<Record<string, boolean>>({});
  const [scheduleFilter, setScheduleFilter] = useState<Record<string, boolean>>({});
  const [walletStatusFilter, setWalletStatusFilter] = useState<Record<string, boolean>>({});
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [depositMenuOpen, setDepositMenuOpen] = useState(false);
  const [withdrawalMenuOpen, setWithdrawalMenuOpen] = useState(false);
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const [walletStatusMenuOpen, setWalletStatusMenuOpen] = useState(false);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const depositButtonRef = useRef<HTMLButtonElement>(null);
  const withdrawalButtonRef = useRef<HTMLButtonElement>(null);
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);
  const walletStatusButtonRef = useRef<HTMLButtonElement>(null);

  // Row-selection checkboxes + Bulk Edit — selection is keyed by each row's
  // `_id` (see WalletStatusRow), reset on every fresh fetch since a refetch
  // means brand-new row objects.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  useEffect(() => {
    setSelectionBarRendered(selectedIds.size > 0);
  }, [selectedIds.size]);

  // One row editable at a time — Priority is the only field this stages.
  // editingRowKey being a single value (not a Set/per-field map) is what
  // makes "starting to edit another row auto-cancels the previous one"
  // free — the old row's cell just stops matching and reverts to showing
  // its saved value with no extra cleanup needed.
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<RowDraft | null>(null);
  const [rowSaving, setRowSaving] = useState(false);

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
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/wallet-status?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, statusRes]);

      const openingText = await openingRes.text();
      const balText = await balRes.text();
      const stlmText = await stlmRes.text();
      const statusData: Record<string, PriorityEntry> = await statusRes.json();

      const reportCutoffDate = getBusinessToday();

      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          openingBal: rawVal(row[1]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      const balRows = parseCsvLines(balText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[1]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          group: rawVal(row[6]),
          accountStatus: rawVal(row[2]),
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
          const topUpAgent = stripBrandSuffix(rawVal(row[1]));
          const topUpAmount = rawVal(row[2]);
          const topUpDate = parseSheetDate(rawVal(row[3]));
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' && topUpDate && topUpDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }
          const stlmAgent = stripBrandSuffix(rawVal(row[7]));
          const stlmAmount = rawVal(row[8]);
          const stlmDate = parseSheetDate(rawVal(row[9]));
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' && stlmDate && stlmDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: WalletStatusRow[] = openingRows.map((opening, index) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
        const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
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
          _id: index,
          key: opening.agentName,
          shopName: opening.agentName,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES }),
          leader: opening.leader,
          companyBalance,
          baseLimit,
          availableLimit,
          frozenAmount: computeFrozenAmount(companyBalance, baseLimit),
          sdpDisplay,
          deposit: flags.deposit,
          withdrawal: flags.withdrawal,
          priority: priorityEntry.priority,
          schedule: resolveSchedule(opening.leader),
          walletStatus: flags.walletStatus,
          remark: priorityEntry.remark,
          remarkUpdatedBy: priorityEntry.updatedBy,
          remarkUpdatedAt: priorityEntry.updatedAt,
        };
      });

      setRows(merged);
      setSelectedIds(new Set());
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
  }, [searchTerm, sortColumn, sortDirection, rowsPerPage, leaderFilter, depositFilter, withdrawalFilter, scheduleFilter, walletStatusFilter]);

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
  // Priority AND Remark — per explicit instruction, Remarks is no longer
  // independently editable, only via this same row-wide edit mode) and
  // enter edit mode. Nothing saves until Save is clicked; Cancel just
  // discards the draft. editingRowKey being a single value means starting
  // to edit a different row automatically ends the previous edit — its
  // cells just stop matching and fall back to showing their saved value.
  const startEdit = useCallback((row: WalletStatusRow) => {
    setEditingRowKey(row.key);
    setEditDraft({ priority: row.priority, remark: row.remark });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingRowKey(null);
    setEditDraft(null);
  }, []);

  const updateDraftField = useCallback((value: Priority) => {
    setEditDraft((current) => (current ? { ...current, priority: value } : current));
  }, []);

  const updateDraftRemark = useCallback((value: string) => {
    setEditDraft((current) => (current ? { ...current, remark: value } : current));
  }, []);

  // The single point where a row's staged Priority AND Remark edits
  // actually persist — to two independent blocks of the same "Wallet
  // Status" sheet tab (see app/lib/walletStatus.ts), only whichever
  // actually changed. On failure, refetches from the server instead of
  // assuming the write didn't land.
  const saveRow = useCallback((row: WalletStatusRow) => {
    if (!editDraft || !rowHasChanges(row, editDraft)) return;
    const priorityChanged = editDraft.priority !== row.priority;
    const remarkChanged = editDraft.remark !== row.remark;

    setRowSaving(true);
    setSaveError(null);

    const priorityRequest = priorityChanged
      ? fetch('/api/wallet-status/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopName: row.shopName, field: 'priority', value: editDraft.priority }),
        }).then((res) => {
          if (!res.ok) throw new Error('Save failed for priority');
        })
      : Promise.resolve();

    const remarkRequest = remarkChanged
      ? fetch('/api/wallet-status/update-remark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopName: row.shopName, remark: editDraft.remark }),
        }).then(async (res) => {
          if (!res.ok) throw new Error('Save failed for remark');
          return (await res.json()) as { updatedBy: string; updatedAt: string };
        })
      : Promise.resolve(null);

    Promise.all([priorityRequest, remarkRequest])
      .then(([, remarkResult]) => {
        setRows((current) => current.map((r) => (r.key === row.key ? {
          ...r,
          priority: priorityChanged ? editDraft.priority : r.priority,
          remark: remarkChanged ? editDraft.remark : r.remark,
          remarkUpdatedBy: remarkResult ? remarkResult.updatedBy : r.remarkUpdatedBy,
          remarkUpdatedAt: remarkResult ? remarkResult.updatedAt : r.remarkUpdatedAt,
        } : r)));
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

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => `${row.shopName} ${row.brand} ${row.remark} ${row.leader} ${row.schedule}`.toLowerCase().includes(query));
  }, [rows, searchTerm]);

  // Toolbar filters — Leader/Deposit/Withdrawal/Schedule/Wallet Status, same
  // shape/behavior as Top Up/Settlement's own Brand/Leader/Wallet filters:
  // the full distinct option universe comes from the whole dataset (`rows`),
  // but each dropdown's own per-option counts are faceted — computed by
  // applying every OTHER filter except its own, so unchecking an option in
  // a dropdown never shrinks that same dropdown's own list toward zero.
  const leaderOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.leader))).sort((a, b) => toProperCase(a).localeCompare(toProperCase(b))),
    [rows]
  );
  const depositOptions = DEPOSIT_WITHDRAWAL_OPTIONS;
  const withdrawalOptions = DEPOSIT_WITHDRAWAL_OPTIONS;
  const scheduleOptions = SCHEDULE_SORT_ORDER;
  const walletStatusOptions = WALLET_STATUS_FILTER_OPTIONS;

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const isDepositChecked = (name: string) => depositFilter[name] !== false;
  const isWithdrawalChecked = (name: string) => withdrawalFilter[name] !== false;
  const isScheduleChecked = (name: string) => scheduleFilter[name] !== false;
  const isWalletStatusChecked = (name: string) => walletStatusFilter[name] !== false;

  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const anyDepositUnchecked = depositOptions.some((name) => !isDepositChecked(name));
  const anyWithdrawalUnchecked = withdrawalOptions.some((name) => !isWithdrawalChecked(name));
  const anyScheduleUnchecked = scheduleOptions.some((name) => !isScheduleChecked(name));
  const anyWalletStatusUnchecked = walletStatusOptions.some((name) => !isWalletStatusChecked(name));

  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;
  const selectedDepositCount = depositOptions.filter((name) => isDepositChecked(name)).length;
  const selectedWithdrawalCount = withdrawalOptions.filter((name) => isWithdrawalChecked(name)).length;
  const selectedScheduleCount = scheduleOptions.filter((name) => isScheduleChecked(name)).length;
  const selectedWalletStatusCount = walletStatusOptions.filter((name) => isWalletStatusChecked(name)).length;

  const anyFilterActive = anyLeaderUnchecked || anyDepositUnchecked || anyWithdrawalUnchecked || anyScheduleUnchecked || anyWalletStatusUnchecked;

  const resetAllFilters = useCallback(() => {
    setLeaderFilter({});
    setDepositFilter({});
    setWithdrawalFilter({});
    setScheduleFilter({});
    setWalletStatusFilter({});
    setLeaderMenuOpen(false);
    setDepositMenuOpen(false);
    setWithdrawalMenuOpen(false);
    setScheduleMenuOpen(false);
    setWalletStatusMenuOpen(false);
  }, []);

  const leaderFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.leader, (counts.get(row.leader) ?? 0) + 1);
    return leaderOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [searchedRows, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, leaderOptions]);

  const depositFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.deposit, (counts.get(row.deposit) ?? 0) + 1);
    return depositOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, depositOptions]);

  const withdrawalFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.withdrawal, (counts.get(row.withdrawal) ?? 0) + 1);
    return withdrawalOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, depositFilter, depositOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, withdrawalOptions]);

  const scheduleFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.schedule, (counts.get(row.schedule) ?? 0) + 1);
    return scheduleOptions.map((name) => ({ value: name, label: SCHEDULE_FILTER_LABEL[name], count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, walletStatusFilter, walletStatusOptions, scheduleOptions]);

  const walletStatusFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.walletStatus, (counts.get(row.walletStatus) ?? 0) + 1);
    return walletStatusOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusOptions]);

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    return list;
  }, [searchedRows, leaderFilter, leaderOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
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
          case 'leader': return row.leader.toLowerCase();
          case 'companyBalance': return row.companyBalance;
          case 'availableLimit': return row.availableLimit;
          case 'frozenAmount': return row.frozenAmount;
          case 'sdp': return row.sdpDisplay === '−' ? -Infinity : parseNumber(row.sdpDisplay);
          case 'deposit': return row.deposit;
          case 'withdrawal': return row.withdrawal;
          case 'priority': return PRIORITY_RANK[row.priority];
          case 'schedule': return SCHEDULE_RANK[row.schedule];
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
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, startIndex + rowsPerPage);

  // Selection only ever acts on the CURRENT PAGE's rows, not the full
  // filtered dataset — same convention as Top Up/Settlement's own "select
  // all" checkbox.
  const pageRowIds = useMemo(() => pagedRows.map((row) => row._id), [pagedRows]);
  const selectedOnPageCount = pageRowIds.filter((id) => selectedIds.has(id)).length;
  const allOnPageSelected = pageRowIds.length > 0 && selectedOnPageCount === pageRowIds.length;

  const toggleRowSelection = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllOnPage = useCallback(() => {
    setSelectedIds((current) => {
      const onPageSelectedCount = pageRowIds.filter((id) => current.has(id)).length;
      if (pageRowIds.length > 0 && onPageSelectedCount === pageRowIds.length) {
        const next = new Set(current);
        pageRowIds.forEach((id) => next.delete(id));
        return next;
      }
      const next = new Set(current);
      pageRowIds.forEach((id) => next.add(id));
      return next;
    });
  }, [pageRowIds]);

  const visibleColumns = useMemo(() => (mounted ? columnDefs : []).filter((col) => col.visible), [columnDefs, mounted]);

  const handleExport = useCallback((rowsOverride?: WalletStatusRow[]) => {
    const getExportValue = (row: WalletStatusRow, key: ColumnKey) => {
      switch (key) {
        case 'brand': return row.brand;
        case 'shopName': return row.shopName;
        case 'leader': return toProperCase(row.leader);
        case 'companyBalance': return row.companyBalance;
        case 'availableLimit': return row.availableLimit;
        case 'frozenAmount': return row.frozenAmount > 0 ? row.frozenAmount : undefined;
        case 'sdp': return row.sdpDisplay;
        case 'deposit': return row.deposit;
        case 'withdrawal': return row.withdrawal;
        case 'priority': return priorityDisplay(row);
        case 'schedule': return row.schedule || undefined;
        case 'walletStatus': return row.walletStatus;
        case 'remarks': return row.remark || '—';
      }
    };
    // The Edit/Save/Cancel action column has no exportable value — excluded
    // from the sheet rather than producing an empty, unlabeled column.
    const exportColumns = visibleColumns.filter((col) => col.key !== 'walletStatusAction');
    const headers = exportColumns.map((col) => col.label);
    const data = (rowsOverride ?? sortedRows).map((row) => exportColumns.map((col) => getExportValue(row, col.key)));
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Wallet Status');
    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `WALLET_STATUS_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const handleExportSelected = useCallback(() => {
    handleExport(sortedRows.filter((row) => selectedIds.has(row._id)));
  }, [handleExport, sortedRows, selectedIds]);

  // Bulk Edit's real persistence path — mirrors saveRow's own POST calls but
  // batched server-side (see /api/wallet-status/bulk-update +
  // updateCashoutWalletStatusBulk) instead of firing one request per
  // selected shop per field. On success, patches every selected row's local
  // state directly from the response (same optimistic-update convention
  // saveRow already uses) instead of forcing a full refetch. On failure,
  // refetches to confirm what actually landed — same as saveRow's own
  // catch path.
  const handleBulkEditApply = useCallback((updates: BulkEditUpdates) => {
    if (bulkSaving) return;
    const selectedRows = rows.filter((row) => selectedIds.has(row._id));
    if (selectedRows.length === 0) return;

    const priority = updates.priority as Priority | undefined;
    const remark = updates.remarks;

    const payload = selectedRows.map((row) => ({
      shopName: row.shopName,
      ...(priority !== undefined ? { priority } : {}),
      ...(remark !== undefined ? { remark } : {}),
    }));

    setBulkSaving(true);
    setSaveError(null);

    fetch('/api/wallet-status/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: payload }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Bulk save failed');
        return (await res.json()) as { updatedBy: string; updatedAt: string };
      })
      .then((result) => {
        setRows((current) => current.map((r) => (selectedIds.has(r._id) ? {
          ...r,
          priority: priority !== undefined ? priority : r.priority,
          remark: remark !== undefined ? remark : r.remark,
          remarkUpdatedBy: remark !== undefined ? result.updatedBy : r.remarkUpdatedBy,
          remarkUpdatedAt: remark !== undefined ? result.updatedAt : r.remarkUpdatedAt,
        } : r)));
        setBulkEditOpen(false);
        setSelectedIds(new Set());
        setToast(`${selectedRows.length} Shop${selectedRows.length === 1 ? '' : 's'} Updated`);
      })
      .catch(() => {
        setSaveError('Bulk save failed — reloading to confirm what actually saved.');
        setTimeout(() => setSaveError(null), 5000);
        setBulkEditOpen(false);
        fetchData();
      })
      .finally(() => {
        setBulkSaving(false);
      });
  }, [rows, selectedIds, fetchData, bulkSaving]);

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
      case 'leader':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{toProperCase(row.leader)}</td>;
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
      case 'schedule':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{row.schedule}</td>;
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
            className={`${shopBase} !overflow-visible align-top`}
          >
            <RemarksCell
              remark={isEditingThisRow && editDraft ? editDraft.remark : row.remark}
              updatedBy={row.remarkUpdatedBy}
              updatedAt={row.remarkUpdatedAt}
              editing={isEditingThisRow}
              onChange={updateDraftRemark}
            />
          </td>
        );
      case 'walletStatusAction': {
        // Sticky to the right edge — per explicit instruction, the user
        // shouldn't have to scroll back across a wide table to reach
        // Save/Cancel after editing a column near the left/middle (e.g.
        // Remarks). An opaque background masks scrolled content sliding
        // underneath; the editing-row tint is mirrored here since a sticky
        // cell paints over its own row's normal background otherwise.
        const stickyBg = isEditingThisRow
          ? 'bg-[#F8F9FF] dark:bg-[#2a2a2d]'
          : selectedIds.has(row._id)
            ? 'bg-[#EFF6FF] dark:bg-[#1e2a3d]'
            : 'bg-white dark:bg-[#1c1c1e]';
        if (!isEditingThisRow) {
          return (
            <td key={key} style={cellStyle} className={`${base} sticky right-0 z-[40] ${stickyBg}`}>
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
          <td key={key} style={cellStyle} className={`${base} sticky right-0 z-[40] ${stickyBg}`}>
            <span className="inline-flex items-center gap-1.5">
              {/* Same size/shape as the Pencil icon above — plain rounded-md
                  muted button, not the previous bold circular treatment —
                  per explicit instruction. */}
              <button
                type="button"
                onClick={() => saveRow(row)}
                disabled={!canSave || rowSaving}
                aria-label="Save Changes"
                title="Save Changes"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {rowSaving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={rowSaving}
                aria-label="Cancel"
                title="Cancel"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
              >
                <X size={15} />
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
            {/* Same style/arrangement as Top Up/Settlement (app/topup/page.tsx):
                Filters (mr-3) -> Search (flex-1, rounded-full) -> [Bulk
                Actions, only while rows are selected] -> Actions (ml-3),
                replacing the old Toolbar/Toolbar.Left/Toolbar.Right layout. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-[#E5E7EB] px-4 py-3 dark:border-[#3a3a3d]">
              {loading ? (
                <div className="mr-3 flex shrink-0 items-center gap-3">
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[100px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[112px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[104px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[128px]" />
                  <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />
                </div>
              ) : (
                <div className="mr-3 flex shrink-0 items-center gap-3">
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
                      label="Deposit"
                      icon={ArrowDownCircle}
                      anyUnchecked={anyDepositUnchecked}
                      selectedCount={selectedDepositCount}
                      menuOpen={depositMenuOpen}
                      buttonRef={depositButtonRef}
                      onClick={() => setDepositMenuOpen((current) => !current)}
                    />
                    <FilterDropdown
                      open={depositMenuOpen}
                      onOpenChange={setDepositMenuOpen}
                      anchorRef={depositButtonRef}
                      options={depositFilterOptions}
                      selected={depositFilter}
                      onChange={setDepositFilter}
                    />
                  </div>
                  <div className="relative">
                    <FilterTriggerButton
                      label="Withdrawal"
                      icon={ArrowUpCircle}
                      anyUnchecked={anyWithdrawalUnchecked}
                      selectedCount={selectedWithdrawalCount}
                      menuOpen={withdrawalMenuOpen}
                      buttonRef={withdrawalButtonRef}
                      onClick={() => setWithdrawalMenuOpen((current) => !current)}
                    />
                    <FilterDropdown
                      open={withdrawalMenuOpen}
                      onOpenChange={setWithdrawalMenuOpen}
                      anchorRef={withdrawalButtonRef}
                      options={withdrawalFilterOptions}
                      selected={withdrawalFilter}
                      onChange={setWithdrawalFilter}
                    />
                  </div>
                  <div className="relative">
                    <FilterTriggerButton
                      label="Schedule"
                      icon={Clock}
                      anyUnchecked={anyScheduleUnchecked}
                      selectedCount={selectedScheduleCount}
                      menuOpen={scheduleMenuOpen}
                      buttonRef={scheduleButtonRef}
                      onClick={() => setScheduleMenuOpen((current) => !current)}
                    />
                    <FilterDropdown
                      open={scheduleMenuOpen}
                      onOpenChange={setScheduleMenuOpen}
                      anchorRef={scheduleButtonRef}
                      options={scheduleFilterOptions}
                      selected={scheduleFilter}
                      onChange={setScheduleFilter}
                    />
                  </div>
                  <div className="relative">
                    <FilterTriggerButton
                      label="Wallet Status"
                      icon={CircleDot}
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

              <div className="flex h-10 flex-1 min-w-[200px] items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-[16px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                {loading ? (
                  <div className="dt-skeleton h-3 w-32 rounded-md" />
                ) : (
                  <>
                    <Search size={16} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
                    <input
                      aria-label="Search shop, leader, or brand"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[13px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                      placeholder="Search shop, leader, or brand..."
                    />
                  </>
                )}
              </div>

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

              <div className="ml-3 flex shrink-0 items-center gap-3">
                {loading && <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px] xl:w-[92px]" />}
                {!loading && (
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={() => handleExport()} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={16} />
                      <span className="hidden xl:inline">Export</span>
                    </button>
                    {exportTooltip.rendered && <ToolbarTooltip label="Export" open={exportTooltip.open} pos={exportTooltip.pos} onlyWhenCompact />}
                  </div>
                )}
                {loading && <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />}
                {!loading && (
                  <div className="relative">
                    <button type="button" ref={refreshButtonRef} onClick={fetchData} aria-label="Refresh Data" {...refreshTooltip.handlers} className={REFRESH_ICON_BUTTON}>
                      <RefreshCw size={16} className={spinning ? 'animate-spin' : ''} />
                    </button>
                    {refreshTooltip.rendered && <ToolbarTooltip label="Refresh Data" open={refreshTooltip.open} pos={refreshTooltip.pos} />}
                  </div>
                )}
                {loading && <div className="h-10 w-10 shrink-0 dt-skeleton rounded-[12px]" />}
                {!loading && (
                  <div className="relative">
                    <button
                      type="button"
                      ref={columnsButtonRef}
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="wallet-status-columns-popover"
                      aria-label="Customize Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={16} />
                    </button>
                    {columnsTooltip.rendered && <ToolbarTooltip label="Customize Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} />}
                    <ColumnsDropdown
                      id="wallet-status-columns-popover"
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
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''}`}>
                    <tr className="h-[48px]">
                      <th className={`${headerCellClasses('center')} w-[44px]`}>
                        {!loading && (
                          <input
                            type="checkbox"
                            aria-label="Select all rows on this page"
                            checked={allOnPageSelected}
                            onChange={toggleSelectAllOnPage}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        )}
                      </th>
                      {visibleColumns.map((col) => (
                        <th
                          key={col.key}
                          style={col.key === 'remarks'
                            ? { width: REMARKS_COLUMN_WIDTH_PX, minWidth: REMARKS_COLUMN_WIDTH_PX, maxWidth: REMARKS_COLUMN_WIDTH_PX }
                            : colWidthsPx[col.key] ? { width: colWidthsPx[col.key], minWidth: colWidthsPx[col.key] } : undefined}
                          className={`${headerCellClasses(col.align)} ${col.key === 'walletStatusAction' ? 'sticky right-0 z-[51] bg-[#FAFAFB] dark:bg-[#252528]' : ''}`}
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
                          <td className="px-4 py-[14px]" />
                          {visibleColumns.map((col) => {
                            const widths = rowSkeletonWidths[col.key];
                            const width = widths[rowIndex % widths.length];
                            const colWidth = colWidthsPx[col.key];
                            return (
                              <td
                                key={col.key}
                                style={colWidth ? { width: colWidth, minWidth: colWidth } : undefined}
                                className={`px-4 py-[14px] ${col.key === 'walletStatusAction' ? 'sticky right-0 z-[40] bg-white dark:bg-[#1c1c1e]' : ''}`}
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
                            : selectedIds.has(row._id)
                              ? 'border-border bg-[#EFF6FF] dark:bg-[#1e2a3d]'
                              : `border-border ${i % 2 === 1 ? 'bg-muted/5' : ''}`
                        }`}
                      >
                        <td className="px-4 py-[14px] text-center align-top" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.shopName}`}
                            checked={selectedIds.has(row._id)}
                            onChange={() => toggleRowSelection(row._id)}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        </td>
                        {visibleColumns.map((col) => renderCell(row, col.key, colWidthsPx))}
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={Math.max(visibleColumns.length, 1) + 1}>
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
                    const showLeader = visibleColumns.some((c) => c.key === 'leader');
                    const showBalance = visibleColumns.some((c) => c.key === 'companyBalance');
                    const showAvailableLimit = visibleColumns.some((c) => c.key === 'availableLimit');
                    const showFrozenAmount = visibleColumns.some((c) => c.key === 'frozenAmount');
                    const showSdp = visibleColumns.some((c) => c.key === 'sdp');
                    const showDeposit = visibleColumns.some((c) => c.key === 'deposit');
                    const showWithdrawal = visibleColumns.some((c) => c.key === 'withdrawal');
                    const showPriority = visibleColumns.some((c) => c.key === 'priority');
                    const showSchedule = visibleColumns.some((c) => c.key === 'schedule');
                    const showWalletStatus = visibleColumns.some((c) => c.key === 'walletStatus');
                    const showRemarks = visibleColumns.some((c) => c.key === 'remarks');
                    const isEditingThisRow = editingRowKey === row.key;
                    const priorityValue = isEditingThisRow && editDraft ? editDraft.priority : row.priority;
                    const canSave = rowHasChanges(row, editDraft);
                    const isSelected = selectedIds.has(row._id);
                    return (
                      <div
                        key={row.key}
                        className={`relative rounded-xl border p-3.5 pr-9 transition-[background-color,border-color] duration-150 ease-out dark:bg-[#2a2a2d] ${
                          isEditingThisRow
                            ? 'border-[#5B5CEB] bg-[#F8F9FF] dark:bg-[#5B5CEB]/[0.08]'
                            : isSelected
                              ? 'border-[#2563EB]/40 bg-[#EFF6FF] dark:bg-[#1e2a3d]'
                              : 'border-border bg-white'
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.shopName}`}
                          checked={isSelected}
                          onChange={() => toggleRowSelection(row._id)}
                          className="absolute right-3.5 top-3.5 h-3.5 w-3.5 cursor-pointer"
                        />
                        {showLeader && (
                          <p className="truncate text-[11px] font-medium text-muted-foreground">{toProperCase(row.leader)}</p>
                        )}
                        {(showShop || showBrand) && (
                          <div className={`flex items-start justify-between gap-2 ${showLeader ? 'mt-0.5' : ''}`}>
                            {showShop && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.shopName}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{row.brand}</span>}
                          </div>
                        )}
                        {(showBalance || showAvailableLimit || showFrozenAmount || showSdp) && (
                          <div className={`grid grid-cols-2 gap-2 ${(showShop || showBrand || showLeader) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                        {(showDeposit || showWithdrawal || showPriority || showSchedule) && (
                          <div className={`flex flex-wrap items-center gap-2 ${(showShop || showBrand || showLeader || showBalance || showAvailableLimit || showFrozenAmount || showSdp) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                            {showSchedule && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Schedule</p>
                                <p className="text-[12px] font-medium text-foreground">{row.schedule}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {showWalletStatus && (
                          <div className={`flex items-center gap-1.5 ${(showShop || showBrand || showLeader || showBalance || showAvailableLimit || showFrozenAmount || showSdp || showDeposit || showWithdrawal || showPriority || showSchedule) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                              remark={isEditingThisRow && editDraft ? editDraft.remark : row.remark}
                              updatedBy={row.remarkUpdatedBy}
                              updatedAt={row.remarkUpdatedAt}
                              editing={isEditingThisRow}
                              onChange={updateDraftRemark}
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

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        priorityOptions={PRIORITY_OPTIONS}
        remarksSuggestions={[]}
        showDateField={false}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />
    </div>
  );
}
