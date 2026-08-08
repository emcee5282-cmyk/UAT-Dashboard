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
import WalletSettingsModal, { type WalletSettingsValues } from '../components/WalletSettingsModal';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '../lib/csv';
import { getPreference, setPreference } from '../lib/preferences';
import {
  resolveBrand,
  computeWalletStatus,
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
// Main Reason / Closure Type / Affected Services / Minimum Amount Can Take
// / Balance Limit Override / Schedule Override ride along on the same
// merged API response (mergeCashoutWalletStatusRemarksAndOverrides in
// app/lib/walletStatus.ts) — Cashout-only, added for the unified Edit
// Wallet Settings modal. Priority stays exactly as it is today (still read
// from the same status block) — it's just no longer editable through that
// modal, per the real design reference.
type MainReason = '' | 'Closed by Operations' | 'High Running Balance' | 'Reduce as per Leader' | 'Wallet Issue' | 'Blocked by Wallet Office' | 'Others';
type ClosureType = '' | 'Temporary Close' | 'Permanent Close';
type AffectedService = 'Deposit' | 'Withdrawal';
type PriorityEntry = {
  priority: Priority;
  remark: string;
  updatedBy: string;
  updatedAt: string;
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  minimumAmountCanTake: number | null;
  balanceLimitOverride: number | null;
  scheduleOverride: Schedule;
};
const DEFAULT_PRIORITY_ENTRY: PriorityEntry = {
  priority: 'Normal', remark: '', updatedBy: '', updatedAt: '',
  mainReason: '', closureType: '', affectedServices: [], minimumAmountCanTake: null, balanceLimitOverride: null, scheduleOverride: '',
};

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

// Whole numbers only (no decimals) — per explicit instruction, SDP/Daily
// Limit/Available Limit show "200,000" not "200,000.00".
function displayNum(num: number): string {
  if (Math.abs(num) < 0.5) return '−';
  const formatted = Math.round(Math.abs(num)).toLocaleString('en-PH');
  return num < 0 ? `-${formatted}` : formatted;
}

// Unlike displayNum, Daily Limit/Available Limit always show a real
// number — 0 is a meaningful, distinct state (limit fully used, or the
// wallet is Inactive) from "no data", so it's never collapsed into the
// dash. Whole numbers only, same as displayNum.
function displayAvailableLimit(num: number): string {
  const formatted = Math.round(Math.abs(num)).toLocaleString('en-PH');
  return num < 0 ? `-${formatted}` : formatted;
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

// Every wallet's own default receiving ceiling before a staff-set Balance
// Limit override (Edit Wallet Settings) replaces it — flat per wallet, not
// scaled by the shop's SDP. Each of a shop's wallets carries its own
// independent limit now (never pooled across the shop's other wallets),
// per explicit instruction — Company Balance/SDP no longer factor into
// Available Limit at all.
const DEFAULT_WALLET_BASE_LIMIT = 200000;

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

// Schedule is never staff-entered — it's derived purely from Leader via
// SCHEDULE_GROUPS below. '' means the leader isn't in any group (renders
// as a blank cell, never "Unknown"/"N/A"/a default, per explicit spec).
type Schedule = 'Early Ext.' | 'Extended' | 'Day' | '24/7' | '';

// Single centralized mapping — add new leaders under the relevant group
// only, never hardcode a Schedule value anywhere else.
const SCHEDULE_GROUPS: Record<Exclude<Schedule, ''>, string[]> = {
  'Early Ext.': ['SHARIF', 'SHAD', 'RIDOY', 'MRLEE', 'SOHARD', 'MIR', 'SONCHOY', 'BERLIN', 'CHAK', 'LIMON', 'SHIK'],
  'Extended': ['RIPAN', 'RC', 'TAPAN', 'LEOLIZA', 'JISAN', 'MONIR', 'NIJHUM', 'AFF JAR'],
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
// rank-based lookup, reversible by sort direction.
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
  // Always a real number — the configured override, or the default, or 0
  // when the wallet is Inactive (see the Daily Limit column rules).
  dailyLimit: number;
  availableLimit: number;
  sdpDisplay: string;
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  schedule: Schedule;
  walletStatus: WalletStatusValue;
  remark: string;
  remarkUpdatedBy: string;
  remarkUpdatedAt: string;
  // Cashout-only Wallet Settings overrides — not visible table columns,
  // only surfaced via the Remarks tooltip / Excel export / the unified
  // Edit Wallet Settings modal itself.
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  minimumAmountCanTake: number | null;
  // null = not overridden (availableLimit above already reflects the live-
  // computed value or the override, whichever applies — this field is the
  // raw override value itself, for the modal's own prefill).
  balanceLimitOverride: number | null;
  // '' = no override, availableSchedule fell back to the Leader-based
  // auto mapping (the `schedule` field above already reflects the winner).
  scheduleOverride: Schedule;
};

const COLUMN_IDS = {
  BRAND: 'brand',
  SHOP_NAME: 'shopName',
  LEADER: 'leader',
  BALANCE_LIMIT: 'balanceLimit',
  AVAILABLE_LIMIT: 'availableLimit',
  SDP: 'sdp',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
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
  { key: COLUMN_IDS.BALANCE_LIMIT, label: 'Daily Limit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AVAILABLE_LIMIT, label: 'Available Limit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SDP, label: 'SDP', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DEPOSIT, label: 'Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WITHDRAWAL, label: 'Withdrawal', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SCHEDULE, label: 'Schedule', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: true, sortable: true, hideable: false, align: 'left' },
  // Independent of Wallet Status/Priority — its own click-to-edit popover,
  // not tied to the row-wide Edit/Save/Cancel below. Fixed width (see
  // computeColumnWidthsPx's own special-case), never measured from content.
  { key: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'center' },
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
// on content" requirement literally. Trimmed 30px narrower than the
// original 280 — reclaimed and handed to SDP/Schedule below (+15px each).
const REMARKS_COLUMN_WIDTH_PX = 250;
// Hover delay before the full-remark tooltip appears — long enough that a
// quick pass-over the cell doesn't flash it, per spec.
const REMARKS_TOOLTIP_HOVER_DELAY_MS = 275;

const COLUMNS_WITH_INFO_ICON: ColumnKey[] = ['balanceLimit', 'availableLimit', 'schedule'];
const PILL_BADGE_COLUMNS: ColumnKey[] = ['deposit', 'withdrawal'];

// Exact display string per column — mirrors renderCell's own per-column
// JSX content, kept as plain strings here purely for width measurement.
function getColumnDisplayText(row: WalletStatusRow, key: ColumnKey): string {
  switch (key) {
    case 'brand': return row.brand;
    case 'shopName': return row.shopName;
    case 'leader': return toProperCase(row.leader);
    case 'balanceLimit': return displayAvailableLimit(row.dailyLimit);
    case 'availableLimit': return displayAvailableLimit(row.availableLimit);
    case 'sdp': return row.sdpDisplay;
    case 'deposit': return row.deposit;
    case 'withdrawal': return row.withdrawal;
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

    // +15px each to SDP and Schedule — the 30px reclaimed from Remarks above.
    const width = Math.max(dataWidth, headerWidth) + (col.key === 'sdp' || col.key === 'schedule' ? 15 : 0);
    if (width > 0) result[col.key] = width;
  }
  return result;
}

const rowSkeletonWidths: Record<ColumnKey, string[]> = {
  brand: ['w-8', 'w-10', 'w-9'],
  shopName: ['w-24', 'w-28', 'w-20'],
  leader: ['w-16', 'w-20', 'w-14'],
  balanceLimit: ['w-16', 'w-20', 'w-14'],
  availableLimit: ['w-16', 'w-14', 'w-20'],
  sdp: ['w-14', 'w-16', 'w-12'],
  deposit: ['w-10', 'w-10', 'w-10'],
  withdrawal: ['w-10', 'w-10', 'w-10'],
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
// Safe distance kept from every viewport edge when clamping — per explicit
// spec, "approximately 12-16px".
const TOOLTIP_VIEWPORT_MARGIN = 14;

function useBelowTooltip(triggerRef: React.RefObject<HTMLElement | null>, options?: { delayMs?: number }) {
  const delayMs = options?.delayMs ?? 0;
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Which side of the trigger the tooltip actually ended up on, and where
  // (as a 0-100% offset from its own left edge) its pointer arrow should
  // sit — both only ever change from the defaults when viewport clamping
  // below actually had to move the tooltip away from directly-below-
  // centered, so a caller that never renders near an edge sees no
  // behavior change at all.
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [arrowOffsetPercent, setArrowOffsetPercent] = useState(50);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

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

  // The effect above only ever guesses "below and centered on the
  // trigger" — real tooltip content (remark length, how many optional
  // sections render) isn't known until it's actually in the DOM, so this
  // second pass measures the real rendered size once `rendered` flips true
  // and repositions/clamps against the actual viewport: flips above the
  // trigger if there's more room there than below, and slides
  // horizontally (never off either side) while dragging the pointer arrow
  // along so it still visually points at the trigger instead of just the
  // tooltip's own center.
  useEffect(() => {
    if (!open || !rendered) return;
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    if (!triggerRect || !tooltipEl) return;

    const tooltipRect = tooltipEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = TOOLTIP_VIEWPORT_MARGIN;

    let top = triggerRect.bottom + 8;
    let nextPlacement: 'below' | 'above' = 'below';
    const spaceBelow = vh - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    if (top + tooltipRect.height > vh - margin && spaceAbove > spaceBelow) {
      top = triggerRect.top - 8 - tooltipRect.height;
      nextPlacement = 'above';
    }
    top = Math.min(Math.max(top, margin), Math.max(margin, vh - tooltipRect.height - margin));

    const halfWidth = tooltipRect.width / 2;
    let left = triggerRect.left + triggerRect.width / 2;
    left = Math.min(Math.max(left, halfWidth + margin), Math.max(halfWidth + margin, vw - halfWidth - margin));

    const triggerCenterX = triggerRect.left + triggerRect.width / 2;
    const tooltipLeftEdge = left - halfWidth;
    const arrowPercent = tooltipRect.width > 0
      ? Math.min(Math.max(((triggerCenterX - tooltipLeftEdge) / tooltipRect.width) * 100, 8), 92)
      : 50;

    setPos((current) => (current.top === top && current.left === left ? current : { top, left }));
    setPlacement((current) => (current === nextPlacement ? current : nextPlacement));
    setArrowOffsetPercent((current) => (Math.abs(current - arrowPercent) < 0.5 ? current : arrowPercent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rendered]);

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
    placement,
    arrowOffsetPercent,
    tooltipRef,
    handlers: {
      onMouseEnter: scheduleOpen,
      onMouseLeave: cancelOpen,
      onFocus: () => setOpen(true),
      onBlur: cancelOpen,
    },
  };
}

const COLUMN_INFO_TEXT: Partial<Record<ColumnKey, string>> = {
  balanceLimit: 'This wallet\'s own configured daily limit, set in Edit Wallet Settings.\n\nNever pooled with the shop\'s other wallets — each wallet keeps its own limit. Leave blank there to use the default (200,000). Shows 0 while the wallet is Inactive.',
  availableLimit: "Remaining receiving capacity for today, for this wallet alone.\n\nFormula:\nDaily Limit − This Wallet's Today's Total Deposit\n\nDoes not factor in Company Balance or SDP. Resets every day at 2:00 AM.",
  schedule: 'Shop operating schedule.\n\nDay\n7:00 AM – 10:00 PM\n\nExtended\n7:00 AM – 11:00 PM\n\nEarly Ext.\n6:00 AM – 12:00 AM\n\n24/7\nOpen 24 Hours\n\nAutomatically determined\nby the assigned Leader.',
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

// Same 5-color mapping as WalletSettingsModal's own Main Reason dot/badge —
// kept in sync manually since this file can't import from a client
// component the modal doesn't export these from either; both are small,
// stable, rarely-changed maps.
const MAIN_REASON_BADGE_STYLES: Record<Exclude<MainReason, ''>, string> = {
  'Closed by Operations': 'bg-slate-50 text-slate-600 dark:bg-slate-500/10 dark:text-slate-400',
  'High Running Balance': 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400',
  'Reduce as per Leader': 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  'Wallet Issue': 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  'Blocked by Wallet Office': 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400',
  'Others': 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400',
};
const MAIN_REASON_DOT_STYLES: Record<Exclude<MainReason, ''>, string> = {
  'Closed by Operations': 'bg-slate-400',
  'High Running Balance': 'bg-rose-500',
  'Reduce as per Leader': 'bg-blue-500',
  'Wallet Issue': 'bg-amber-500',
  'Blocked by Wallet Office': 'bg-orange-500',
  'Others': 'bg-indigo-500',
};
const CLOSURE_TYPE_BADGE_STYLES: Record<Exclude<ClosureType, ''>, string> = {
  'Temporary Close': 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  'Permanent Close': 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

// Read-only — editing now happens exclusively through the unified Edit
// Wallet Settings modal (opened from the row's own Pencil icon), never
// inline here. A single-line, ellipsis-truncated value (or an italic "Add
// Remark" placeholder when empty) with the full remark + operational
// summary + attribution on hover via the same useBelowTooltip pattern
// already used by HeaderInfoIcon. Per explicit instruction this tooltip is
// Remarks information only — Minimum Amount/Balance Limit/Schedule/
// Available Limit/Frozen Amount/Priority are never shown here, they stay
// in their own visible table columns.
function RemarksCell({
  remark,
  updatedBy,
  updatedAt,
  mainReason,
  closureType,
  affectedServices,
}: {
  remark: string;
  updatedBy: string;
  updatedAt: string;
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltip = useBelowTooltip(triggerRef, { delayMs: REMARKS_TOOLTIP_HOVER_DELAY_MS });
  const hasRemark = remark.trim() !== '';
  const hasMainReason = mainReason !== '';
  const hasClosureType = closureType !== '';
  const hasOperationalInfo = hasMainReason || hasClosureType;
  const hasTooltipContent = hasRemark || hasOperationalInfo;
  const depositClosed = affectedServices.includes('Deposit');
  const withdrawalClosed = affectedServices.includes('Withdrawal');

  return (
    <span
      ref={triggerRef}
      {...(hasTooltipContent ? tooltip.handlers : {})}
      className="flex h-7 w-full max-w-full items-center overflow-hidden"
    >
      {hasRemark ? (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[12px] font-normal text-slate-700 dark:text-slate-300">{remark}</span>
      ) : (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-center text-[12px] font-normal italic text-slate-400 dark:text-slate-500">No Remarks</span>
      )}
      {hasTooltipContent && tooltip.rendered && typeof document !== 'undefined' && createPortal(
        // Light "premium floating card" per spec (explicit literal hex
        // values, not the semantic dark/light theme tokens the rest of the
        // app pairs everything with) — a deliberate one-off design that
        // stays white regardless of app theme. Enters with a fade + slight
        // 4px upward lift + scale from 0.97 (never scale(0) — Kowalski:
        // nothing in the real world pops in from nothing); exits the same
        // transition reversed (a true fade-only exit would need a separate
        // exit-only transition definition, not worth the extra complexity
        // for a hover tooltip).
        <div
          ref={tooltip.tooltipRef}
          style={{
            position: 'fixed',
            top: tooltip.pos.top,
            left: tooltip.pos.left,
            transform: `translate(-50%, ${tooltip.open ? '0' : '4px'}) scale(${tooltip.open ? 1 : 0.97})`,
            transformOrigin: tooltip.placement === 'above' ? 'bottom center' : 'top center',
          }}
          className={`pointer-events-none z-[9999] w-[440px] max-w-[90vw] rounded-2xl border border-[#E5E7EB] bg-white p-6 text-left shadow-[0_10px_30px_rgba(15,23,42,0.12)] transition-[opacity,transform] duration-200 ease-out ${tooltip.open ? 'opacity-100' : 'opacity-0'}`}
        >
          <div className="flex items-center gap-2">
            <span className="text-[16px] leading-none">📝</span>
            <h3 className="text-[18px] font-semibold text-[#0F172A]">Remarks</h3>
          </div>

          <p className="mt-4 line-clamp-4 whitespace-pre-line break-words text-[13px] font-normal leading-[1.6] text-[#334155]">
            {hasRemark ? remark : '—'}
          </p>

          {hasOperationalInfo && (
            <>
              <div className="my-5 border-t border-[#E5E7EB]" />
              <div className="space-y-3.5">
                {hasMainReason && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-medium text-[#334155]">Main Reason</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${MAIN_REASON_DOT_STYLES[mainReason]}`} />
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${MAIN_REASON_BADGE_STYLES[mainReason]}`}>
                        {mainReason}
                      </span>
                    </span>
                  </div>
                )}
                {hasClosureType && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-medium text-[#334155]">Closure Type</span>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${CLOSURE_TYPE_BADGE_STYLES[closureType]}`}>
                      {closureType === 'Temporary Close' ? 'Temporary' : 'Permanent'}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-[#334155]">DP</span>
                  <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${depositClosed ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {depositClosed ? <X size={14} /> : <Check size={14} />}
                    {depositClosed ? 'Closed' : 'Open'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-[#334155]">WD</span>
                  <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${withdrawalClosed ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {withdrawalClosed ? <X size={14} /> : <Check size={14} />}
                    {withdrawalClosed ? 'Closed' : 'Open'}
                  </span>
                </div>
              </div>
            </>
          )}

          {(updatedBy || updatedAt) && (
            <>
              <div className="my-5 border-t border-[#E5E7EB]" />
              <div className="grid grid-cols-2">
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#94A3B8]">
                    <span className="leading-none">📅</span> Last Updated
                  </p>
                  <p className="mt-1 text-[13px] font-semibold text-[#0F172A]">{updatedAt ? formatRemarkTimestamp(updatedAt) : '—'}</p>
                </div>
                <div className="border-l border-[#E5E7EB] pl-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#94A3B8]">
                    <span className="leading-none">👤</span> Edited By
                  </p>
                  <p className="mt-1 text-[13px] font-semibold text-[#0F172A]">{updatedBy || '—'}</p>
                </div>
              </div>
            </>
          )}
          {/* Pointer arrow — tracks arrowOffsetPercent (not a fixed 50%)
              since horizontal viewport clamping can shift the tooltip away
              from being centered on its trigger; flips to the bottom edge
              pointing down when the tooltip had to flip above the trigger
              instead of its usual below placement. */}
          <span
            style={{ left: `${tooltip.arrowOffsetPercent}%` }}
            className={`absolute h-2 w-2 -translate-x-1/2 rotate-45 border-[#E5E7EB] bg-white ${
              tooltip.placement === 'above' ? 'bottom-0 translate-y-1/2 border-b border-r' : 'top-0 -translate-y-1/2 border-l border-t'
            }`}
          />
        </div>,
        document.body
      )}
    </span>
  );
}

// Deposit/Withdrawal/Wallet Status are computed (see deriveWalletFlags).
// Priority/Remarks/Main Issue/Balance Limit/Schedule are all edited
// together via the unified Edit Wallet Settings modal (WalletSettingsModal)
// opened from the row's own Pencil icon — no more per-cell inline editing.
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
  const [sortColumn, setSortColumn] = useState<ColumnKey>('shopName');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
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
  useEffect(() => {
    setSelectionBarRendered(selectedIds.size > 0);
  }, [selectedIds.size]);

  // Unified Edit Wallet Settings modal — single mode when editModalOpen is
  // true (one wallet, opened from its own row's Pencil icon), bulk mode
  // when bulkEditOpen is true (the toolbar's Bulk Edit action). Only one
  // can realistically be open at a time. editModalRow is kept separate from
  // editModalOpen (and never cleared on close, only overwritten on the next
  // open) so the modal component stays mounted — with real shopName/
  // initialValues to render — through its own closing fade/scale animation
  // instead of unmounting mid-transition the instant the row goes away.
  const [editModalRow, setEditModalRow] = useState<WalletStatusRow | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [isScrolled, setIsScrolled] = useState(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [atScrollStart, setAtScrollStart] = useState(true);
  const [atScrollEnd, setAtScrollEnd] = useState(true);
  // The scroll container's own live content-box width — tracked so columns
  // can be scaled up in JS to exactly fill it on every resize (browser
  // window, zoom, sidebar toggle). table-layout:auto's own space
  // redistribution isn't reliably consistent enough across browsers/zoom
  // levels to trust on its own, per explicit report of a real gap on a
  // production window resize.
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      setIsScrolled(el.scrollTop > 0);
      setAtScrollStart(el.scrollLeft <= 1);
      setAtScrollEnd(el.scrollLeft >= el.scrollWidth - el.offsetWidth - 1);
    };
    const handleResize = () => {
      handleScroll();
      setContainerWidth(el.clientWidth);
    };
    handleResize();
    el.addEventListener('scroll', handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(handleResize);
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

      const [openingRes, balRes, statusRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/wallet-status?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, statusRes]);

      const openingText = await openingRes.text();
      const balText = await balRes.text();
      const statusData: Record<string, PriorityEntry> = await statusRes.json();

      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      // Leader/SDP are shop-level (Opening AG has one row per shop) —
      // looked up per wallet below by the shop's own bare code, same value
      // repeated across however many wallets that shop has.
      const leaderByShop = new Map<string, string>();
      const sdpByShop = new Map<string, string>();
      openingRows.forEach((row) => {
        leaderByShop.set(row.agentName, row.leader);
        sdpByShop.set(row.agentName, row.sdp);
      });

      // "SSP AG BalanceLimit" has one row per WALLET (Bkash/Nagad/Rocket/
      // UPay), not per shop — col H ("Account") is "<phone> - <code>"
      // (e.g. "01818938877 - D-M1AG-M1-JETT003-BK"); the code half becomes
      // this page's own row identity (Shop Name + the key persisted
      // Priority/Remarks/Wallet Settings save under) per explicit
      // instruction — a shop's several wallets must never be pooled into
      // one row again, each keeps its own balance/limit/status.
      const balRows = parseCsvLines(balText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => {
          const account = rawVal(row[7]);
          const separator = account.indexOf(' - ');
          const walletCode = separator === -1 ? account : account.slice(separator + 3).trim();
          return {
            bareShopName: rawVal(row[1]),
            walletCode,
            totalDP: rawVal(row[11]),
            group: rawVal(row[6]),
            accountStatus: rawVal(row[2]),
          };
        })
        .filter((row) => row.bareShopName && row.bareShopName !== '-' && row.bareShopName !== 'OLD' && row.walletCode && row.walletCode !== '-');

      const merged: WalletStatusRow[] = balRows.map((bal, index) => {
        const totalDP = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const sdpRaw = sdpByShop.get(bal.bareShopName) ?? '';
        const sdpNum = parseNumber(sdpRaw);
        const sdpTrimmed = sdpRaw.trim().toUpperCase();
        const sdpDisplay = sdpTrimmed === 'NO SDP' || !sdpRaw || sdpRaw === '-' ? '−' : displayNum(sdpNum);
        const computedStatus = computeWalletStatus([bal.accountStatus]);
        const flags = deriveWalletFlags(computedStatus);
        const priorityEntry = statusData[bal.walletCode.toUpperCase()] ?? DEFAULT_PRIORITY_ENTRY;
        // Every wallet carries its own limit, never pooled with the shop's
        // other wallets — Company Balance/SDP no longer factor in at all,
        // per explicit instruction. A staff-set Daily Limit override (via
        // Edit Wallet Settings) replaces the flat default; either way only
        // THIS wallet's own today's Total Deposit gets subtracted from it
        // to produce Available Limit. An Inactive wallet unconditionally
        // shows 0 for both Daily Limit and Available Limit, regardless of
        // any configured override (the override itself is untouched in the
        // sheet — it just isn't reflected here while Inactive).
        const dailyLimit = flags.walletStatus === 'Inactive' ? 0 : (priorityEntry.balanceLimitOverride ?? DEFAULT_WALLET_BASE_LIMIT);
        const availableLimit = Math.max(dailyLimit - totalDP, 0);
        return {
          _id: index,
          key: bal.walletCode,
          shopName: bal.walletCode,
          brand: resolveBrand([bal.group], bal.walletCode, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES }),
          leader: leaderByShop.get(bal.bareShopName) ?? '−',
          dailyLimit,
          availableLimit,
          sdpDisplay,
          deposit: flags.deposit,
          withdrawal: flags.withdrawal,
          schedule: priorityEntry.scheduleOverride || resolveSchedule(leaderByShop.get(bal.bareShopName) ?? ''),
          walletStatus: flags.walletStatus,
          remark: priorityEntry.remark,
          remarkUpdatedBy: priorityEntry.updatedBy,
          remarkUpdatedAt: priorityEntry.updatedAt,
          mainReason: priorityEntry.mainReason,
          closureType: priorityEntry.closureType,
          affectedServices: priorityEntry.affectedServices,
          minimumAmountCanTake: priorityEntry.minimumAmountCanTake,
          balanceLimitOverride: priorityEntry.balanceLimitOverride,
          scheduleOverride: priorityEntry.scheduleOverride,
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

  // Opens the unified modal for one wallet — Cancel/closing the modal just
  // discards nothing-yet-typed state (the modal owns its own draft
  // internally), no row-level draft to clean up here anymore.
  const openEditModal = useCallback((row: WalletStatusRow) => {
    setModalError(null);
    setEditModalRow(row);
    setEditModalOpen(true);
  }, []);

  const closeEditModal = useCallback(() => {
    setEditModalOpen(false);
    setModalError(null);
  }, []);

  // Single-wallet save — one POST for all fields (Remarks, Main Reason,
  // Closure Type, Affected Services, Minimum Amount Can Take, Balance
  // Limit, Schedule; Priority is NOT part of this modal), replacing the
  // old two-request saveRow. Kept open with an inline error on failure
  // (per explicit modal design) rather than the old close-and-refetch
  // pattern, since the draft now lives entirely inside the modal and is
  // worth letting the admin retry without re-entering everything.
  // Refetches on success rather than patching the row in place — Available
  // Limit depends on today's total DP (not stored on WalletStatusRow, only
  // used transiently while building rows), so a correct post-save
  // Available Limit/Schedule can only come from a real refetch, not a
  // client-side recompute.
  const handleModalSave = useCallback((values: WalletSettingsValues) => {
    if (!editModalRow) return;
    const row = editModalRow;
    setModalSaving(true);
    setModalError(null);

    const balanceLimitOverride = values.balanceLimitOverride.trim() === '' ? null : Number(values.balanceLimitOverride);
    const minimumAmountCanTake = values.minimumAmountCanTake.trim() === '' ? null : Number(values.minimumAmountCanTake);

    fetch('/api/wallet-status/update-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: row.shopName,
        remark: values.remark,
        mainReason: values.mainReason,
        closureType: values.closureType,
        affectedServices: values.affectedServices,
        minimumAmountCanTake,
        balanceLimitOverride,
        scheduleOverride: values.scheduleOverride,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Save failed');
      })
      .then(async () => {
        closeEditModal();
        setToast('Changes Saved');
        await fetchData();
      })
      .catch(() => {
        setModalError('Failed to save — please try again.');
      })
      .finally(() => {
        setModalSaving(false);
      });
  }, [editModalRow, closeEditModal, fetchData]);

  // Bulk save — sends only the enabled fields for every selected wallet in
  // one request, same shared endpoint/batching /api/wallet-status/
  // bulk-update already used for Priority/Remark. A full refetch afterward
  // (rather than patching rows in place like the single-save path) since
  // Balance Limit/Schedule overrides interact with computed fields
  // (Available Limit, effective Schedule) in ways that are simplest to just
  // re-derive from a fresh fetch rather than replicate client-side per row.
  const handleModalSaveBulk = useCallback((updates: Partial<WalletSettingsValues>) => {
    const selectedRows = rows.filter((row) => selectedIds.has(row._id));
    if (selectedRows.length === 0) return;

    const payload = selectedRows.map((row) => ({
      shopName: row.shopName,
      ...(updates.remark !== undefined ? { remark: updates.remark } : {}),
      ...(updates.mainReason !== undefined ? { mainReason: updates.mainReason } : {}),
      ...(updates.closureType !== undefined ? { closureType: updates.closureType } : {}),
      ...(updates.affectedServices !== undefined ? { affectedServices: updates.affectedServices } : {}),
      ...(updates.minimumAmountCanTake !== undefined ? { minimumAmountCanTake: updates.minimumAmountCanTake.trim() === '' ? null : Number(updates.minimumAmountCanTake) } : {}),
      ...(updates.balanceLimitOverride !== undefined ? { balanceLimitOverride: updates.balanceLimitOverride.trim() === '' ? null : Number(updates.balanceLimitOverride) } : {}),
      ...(updates.scheduleOverride !== undefined ? { scheduleOverride: updates.scheduleOverride } : {}),
    }));

    setModalSaving(true);
    setModalError(null);

    fetch('/api/wallet-status/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: payload }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Bulk save failed');
      })
      .then(async () => {
        setBulkEditOpen(false);
        setSelectedIds(new Set());
        setToast(`${selectedRows.length} Shop${selectedRows.length === 1 ? '' : 's'} Updated`);
        await fetchData();
      })
      .catch(() => {
        setModalError('Bulk save failed — please try again.');
      })
      .finally(() => {
        setModalSaving(false);
      });
  }, [rows, selectedIds, fetchData]);

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
  const walletStatusOptions = useMemo(
    () => WALLET_STATUS_FILTER_OPTIONS.filter((status) => rows.some((r) => r.walletStatus === status)),
    [rows]
  );

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
          case 'balanceLimit': return row.dailyLimit;
          case 'availableLimit': return row.availableLimit;
          case 'sdp': return row.sdpDisplay === '−' ? -Infinity : parseNumber(row.sdpDisplay);
          case 'deposit': return row.deposit;
          case 'withdrawal': return row.withdrawal;
          case 'schedule': return SCHEDULE_RANK[row.schedule];
          case 'walletStatus': return row.walletStatus;
          default: return row.availableLimit;
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

  // Checkbox column is a fixed 44px outside colWidthsPx (its own hardcoded
  // `w-[44px]` th below); Remarks/Action are pinned per spec (never grow
  // with content or with extra space) — only the remaining "normal"
  // columns' natural (measured-minimum) widths get scaled UP to consume
  // whatever's left of the container, so the table always fills it exactly
  // rather than leaving a gap when the viewport is wider than the content
  // actually needs.
  const CHECKBOX_COLUMN_WIDTH_PX = 44;
  const scaledColWidthsPx = useMemo(() => {
    const pinned = new Set<ColumnKey>(['remarks', 'walletStatusAction']);
    const flexibleCols = visibleColumns.filter((col) => !pinned.has(col.key));
    const flexibleNaturalTotal = flexibleCols.reduce((sum, col) => sum + (colWidthsPx[col.key] ?? 0), 0);
    const pinnedTotal = visibleColumns.reduce((sum, col) => {
      if (col.key === 'remarks') return sum + REMARKS_COLUMN_WIDTH_PX;
      if (col.key === 'walletStatusAction') return sum + WALLET_STATUS_ACTION_WIDTH_PX;
      return sum;
    }, 0);
    const available = containerWidth - CHECKBOX_COLUMN_WIDTH_PX - pinnedTotal;
    if (flexibleNaturalTotal <= 0 || available <= flexibleNaturalTotal) return colWidthsPx;
    const factor = available / flexibleNaturalTotal;
    const scaled: Partial<Record<ColumnKey, number>> = { ...colWidthsPx };
    flexibleCols.forEach((col) => {
      const natural = colWidthsPx[col.key];
      if (natural) scaled[col.key] = Math.floor(natural * factor);
    });
    return scaled;
  }, [colWidthsPx, visibleColumns, containerWidth]);

  const handleExport = useCallback((rowsOverride?: WalletStatusRow[]) => {
    const getExportValue = (row: WalletStatusRow, key: ColumnKey) => {
      switch (key) {
        case 'brand': return row.brand;
        case 'shopName': return row.shopName;
        case 'leader': return toProperCase(row.leader);
        case 'balanceLimit': return row.dailyLimit;
        case 'availableLimit': return row.availableLimit;
        case 'sdp': return row.sdpDisplay;
        case 'deposit': return row.deposit;
        case 'withdrawal': return row.withdrawal;
        case 'schedule': return row.schedule || undefined;
        case 'walletStatus': return row.walletStatus;
        case 'remarks': return row.remark || '—';
      }
    };
    // The Edit action column has no exportable value — excluded from the
    // sheet rather than producing an empty, unlabeled column.
    const exportColumns = visibleColumns.filter((col) => col.key !== 'walletStatusAction');
    // Main Reason/Closure Type/Affected Services/Minimum Amount Can Take
    // are never their own visible table columns (per explicit instruction
    // — Main Reason etc. only surface in the Remarks tooltip/here) —
    // always appended to the export regardless of column-visibility
    // toggles.
    const headers = [...exportColumns.map((col) => col.label), 'Main Reason', 'Closure Type', 'Affected Services', 'Minimum Amount Can Take'];
    const data = (rowsOverride ?? sortedRows).map((row) => [
      ...exportColumns.map((col) => getExportValue(row, col.key)),
      row.mainReason || undefined,
      row.closureType || undefined,
      row.affectedServices.length > 0 ? row.affectedServices.join(', ') : undefined,
      row.minimumAmountCanTake ?? undefined,
    ]);
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
  // selected shop per field — see handleModalSaveBulk above, which now
  // handles this via the same unified WalletSettingsModal (bulk mode).

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
    const width = colWidthsPx?.[key];
    const cellStyle = width ? { width, minWidth: width } : undefined;
    switch (key) {
      case 'brand':
        return <td key={key} style={cellStyle} className={base}><BrandBadge>{row.brand}</BrandBadge></td>;
      case 'shopName':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{row.shopName}</td>;
      case 'leader':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{toProperCase(row.leader)}</td>;
      case 'balanceLimit':
        return (
          <td key={key} style={cellStyle} className={`${base} tabular-nums text-foreground`}>
            {displayAvailableLimit(row.dailyLimit)}
          </td>
        );
      case 'availableLimit':
        return (
          <td key={key} style={cellStyle} className={`${base} tabular-nums text-foreground`}>
            {displayAvailableLimit(row.availableLimit)}
          </td>
        );
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
      case 'schedule':
        return <td key={key} style={cellStyle} className={`${base} text-foreground`}>{row.schedule}</td>;
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
              remark={row.remark}
              updatedBy={row.remarkUpdatedBy}
              updatedAt={row.remarkUpdatedAt}
              mainReason={row.mainReason}
              closureType={row.closureType}
              affectedServices={row.affectedServices}
            />
          </td>
        );
      case 'walletStatusAction': {
        // Sticky to the right edge, same as before — no more Save/Cancel
        // branch here, the Pencil always opens the unified Edit Wallet
        // Settings modal instead of entering row-wide inline edit.
        const stickyBg = selectedIds.has(row._id)
          ? 'bg-[#EFF6FF] dark:bg-[#1e2a3d]'
          : 'bg-white dark:bg-[#1c1c1e]';
        return (
          <td key={key} style={cellStyle} className={`${base} sticky right-0 z-[40] ${stickyBg}`}>
            <button
              type="button"
              onClick={() => openEditModal(row)}
              aria-label="Edit"
              title="Edit"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
            >
              <SquarePen size={15} />
            </button>
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
                      label="DP"
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
                      label="WD"
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
                            : scaledColWidthsPx[col.key] ? { width: scaledColWidthsPx[col.key], minWidth: scaledColWidthsPx[col.key] } : undefined}
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
                              <span className={`min-w-0 truncate ${col.align === 'center' && col.key !== 'remarks' ? 'flex-1' : ''}`}>{col.label}</span>
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
                            const colWidth = scaledColWidthsPx[col.key];
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
                          selectedIds.has(row._id)
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
                        {visibleColumns.map((col) => renderCell(row, col.key, scaledColWidthsPx))}
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
                    const showBalanceLimit = visibleColumns.some((c) => c.key === 'balanceLimit');
                    const showAvailableLimit = visibleColumns.some((c) => c.key === 'availableLimit');
                    const showSdp = visibleColumns.some((c) => c.key === 'sdp');
                    const showDeposit = visibleColumns.some((c) => c.key === 'deposit');
                    const showWithdrawal = visibleColumns.some((c) => c.key === 'withdrawal');
                    const showSchedule = visibleColumns.some((c) => c.key === 'schedule');
                    const showWalletStatus = visibleColumns.some((c) => c.key === 'walletStatus');
                    const showRemarks = visibleColumns.some((c) => c.key === 'remarks');
                    const isSelected = selectedIds.has(row._id);
                    return (
                      <div
                        key={row.key}
                        className={`relative rounded-xl border p-3.5 pr-9 transition-[background-color,border-color] duration-150 ease-out dark:bg-[#2a2a2d] ${
                          isSelected
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
                        {(showBalanceLimit || showAvailableLimit || showSdp) && (
                          <div className={`grid grid-cols-2 gap-2 ${(showShop || showBrand || showLeader) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showBalanceLimit && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Daily Limit</p>
                                <p className="text-[13px] font-bold tabular-nums text-foreground">{displayAvailableLimit(row.dailyLimit)}</p>
                              </div>
                            )}
                            {showAvailableLimit && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Available Limit</p>
                                <p className="text-[13px] font-semibold tabular-nums text-foreground">{displayAvailableLimit(row.availableLimit)}</p>
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
                        {(showDeposit || showWithdrawal || showSchedule) && (
                          <div className={`flex flex-wrap items-center gap-2 ${(showShop || showBrand || showLeader || showBalanceLimit || showAvailableLimit || showSdp) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                            {showSchedule && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Schedule</p>
                                <p className="text-[12px] font-medium text-foreground">{row.schedule}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {showWalletStatus && (
                          <div className={`flex items-center gap-1.5 ${(showShop || showBrand || showLeader || showBalanceLimit || showAvailableLimit || showSdp || showDeposit || showWithdrawal || showSchedule) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                              mainReason={row.mainReason}
                              closureType={row.closureType}
                              affectedServices={row.affectedServices}
                            />
                          </div>
                        )}
                        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(row)}
                            className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md text-[12px] font-semibold text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
                          >
                            <SquarePen size={14} /> Edit
                          </button>
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

      {editModalRow && (
        <WalletSettingsModal
          mode="single"
          isOpen={editModalOpen}
          onClose={closeEditModal}
          saving={modalSaving}
          errorMessage={modalError}
          shopName={editModalRow.shopName}
          lastUpdatedAt={editModalRow.remarkUpdatedAt}
          lastUpdatedBy={editModalRow.remarkUpdatedBy}
          initialValues={{
            mainReason: editModalRow.mainReason,
            closureType: editModalRow.closureType,
            affectedServices: editModalRow.affectedServices,
            remark: editModalRow.remark,
            minimumAmountCanTake: editModalRow.minimumAmountCanTake === null ? '' : String(editModalRow.minimumAmountCanTake),
            balanceLimitOverride: editModalRow.balanceLimitOverride === null ? '' : String(editModalRow.balanceLimitOverride),
            scheduleOverride: editModalRow.scheduleOverride,
          }}
          onSave={handleModalSave}
        />
      )}

      <WalletSettingsModal
        mode="bulk"
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        saving={modalSaving}
        errorMessage={modalError}
        selectedCount={selectedIds.size}
        onSaveBulk={handleModalSaveBulk}
      />
    </div>
  );
}
