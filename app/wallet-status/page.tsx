'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, Search, Flag, Check, X,
  SquarePen, Loader2, Info, FilterX, CheckSquare, Pencil, Trash2, User, ArrowDownCircle,
  ArrowUpCircle, Clock, CircleDot, Wallet,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Manrope, Space_Grotesk } from 'next/font/google';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import DataTable from '../components/DataTable';
import FilterDropdown from '../components/FilterDropdown';
import ColumnsDropdown from '../components/ColumnsDropdown';
import CompactTableFooter from '../components/CompactTableFooter';
import EmptyState from '../components/EmptyState';
import TableLoadingSpinner from '../components/TableLoadingSpinner';
import WalletSettingsModal, { type WalletSettingsValues } from '../components/WalletSettingsModal';
import WalletLimitUsedPanel from '../components/WalletLimitUsedPanel';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { getPreference, setPreference } from '../lib/preferences';
import {
  resolveBrand,
  computeWalletStatus,
  allocateSdpAcrossWallets,
  type SdpAllocationWallet,
} from '../lib/balanceEngine';
import type { BalanceLimitWalletRow } from '../lib/db/read/balanceLimit';

// Page-scoped font override (Manrope for body/labels, Space Grotesk for
// tabular-nums) — per explicit instruction, matching the Balance page's own
// typeface exactly (not just its numeric font size, done in a prior pass).
// Every other page keeps Inter.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

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
// Granular — matches the Balance page's own Wallet Status column style
// (app/agentbal/page.tsx's walletStatusBadgeClasses) instead of collapsing
// DP+WD/DP Only/WD Only/Top Up Acc. into a generic "Active", per explicit
// instruction. Login=No still always wins as "Disconnected" (see
// deriveWalletFlags below).
type WalletStatusValue = 'DP + WD' | 'DP Only' | 'WD Only' | 'Top Up Acc.' | 'Wallet With Issue' | 'Account Problem' | 'Disable' | 'Disconnected';
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
// / Schedule Override ride along on the same merged API response
// (mergeCashoutWalletStatusRemarksAndOverrides in
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
};
const DEFAULT_PRIORITY_ENTRY: PriorityEntry = {
  priority: 'Normal', remark: '', updatedBy: '', updatedAt: '',
  mainReason: '', closureType: '', affectedServices: [], minimumAmountCanTake: null,
};

// Same light-bg pill palette as the Balance page's own walletStatusBadgeClasses
// (app/agentbal/page.tsx) — copied verbatim, per explicit instruction to
// match that page's Wallet Status style exactly instead of this page's old
// solid-dot-plus-plain-text treatment.
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
    case 'Disable':
      return 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30 dark:bg-[#F59E0B]/15 dark:border-[#F59E0B]/40';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
  }
}

function WalletStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-[4px] rounded-md border px-[4px] py-[2px] text-[10px] font-medium transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletStatusBadgeClasses(status)}`}>
      <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-current" />
      {status}
    </span>
  );
}

// Wallet Status priority order, per explicit instruction — evaluated in
// this exact sequence, each one short-circuiting everything below it:
//   1. Login = No -> "Disconnected", unconditionally. Overrides every other
//      signal (Disable, Wallet With Issue, Account Problem, an open Group,
//      all of it) — checked first, as its own isLoggedIn parameter, NOT
//      folded into computedStatus like this used to be (the old
//      `computeWalletStatus([isLoggedIn ? accountStatus : 'Disconnected'])`
//      pattern made "Login=No" indistinguishable from "Login=Yes but
//      unrecognized/blank Group text" — both collapsed to the identical
//      'Disconnected' string, which this rewrite needs to tell apart: only
//      a genuine Login=No case may ever display "Disconnected" now).
//   2. Status = Daily/Monthly Reach Limit -> Send Money only (see that
//      page's own version of this function) — Cashout has no real data
//      using this Status value, per explicit instruction to leave it
//      unscoped here.
//   3. Anything else -> displayed EXACTLY as computeWalletStatus() already
//      resolved it ("DP + WD" / "DP Only" / "WD Only" / "Top Up Acc." /
//      "Wallet With Issue" / "Disable" / "Account Problem"), matching the
//      Balance page's own Wallet Status column style verbatim — per
//      explicit instruction, no longer collapsed into a generic "Active"/
//      "Inactive". Deposit/Withdrawal flags are a pure function of which
//      of those it is (both "No" for every status that isn't itself
//      deposit/withdrawal-capable — Disable/Wallet With Issue/Account
//      Problem/Disconnected all fall out of this correctly with no
//      separate branch needed).
function deriveWalletFlags(isLoggedIn: boolean, computedStatus: string): { walletStatus: WalletStatusValue; deposit: DepositWithdrawal; withdrawal: DepositWithdrawal } {
  if (!isLoggedIn) {
    return { walletStatus: 'Disconnected', deposit: 'No', withdrawal: 'No' };
  }
  const hasDeposit = computedStatus === 'DP + WD' || computedStatus === 'DP Only' || computedStatus === 'Top Up Acc.';
  const hasWithdrawal = computedStatus === 'DP + WD' || computedStatus === 'WD Only';
  return { walletStatus: computedStatus as WalletStatusValue, deposit: hasDeposit ? 'Yes' : 'No', withdrawal: hasWithdrawal ? 'Yes' : 'No' };
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
// Toolbar buttons scaled to 80% (40px -> 32px), matching the table's own
// compact sizing.
const ICON_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label) — Columns only.
const ICON_ONLY_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

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
        className="inline-flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5"
      >
        <Icon size={12} className="text-[#475569] dark:text-[#9CA3AF]" />
        <span className="hidden xl:inline">{label}</span>
        {anyUnchecked && (
          <span className="flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-indigo-600 px-[3px] text-[9px] font-semibold text-white">
            {selectedCount}
          </span>
        )}
        <ChevronDown
          size={11}
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
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out-strong)] ${
          anyFilterActive
            ? 'cursor-pointer border-[#E2E8F0] bg-white text-indigo-600 hover:border-[#FCA5A5] hover:bg-[#FEF2F2] hover:text-[#DC2626] active:scale-[0.97] active:border-[#FCA5A5] active:bg-[#FEF2F2] active:text-[#DC2626] dark:border-[#262B38] dark:bg-[#12151D] dark:text-indigo-400'
            : 'cursor-default border-[#E2E8F0] bg-white text-[#475569] opacity-40 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF]'
        }`}
      >
        <FilterX size={16} fill={anyFilterActive ? 'currentColor' : 'none'} />
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
            <div className="my-1 border-t border-[#F1F5F9] dark:border-[#1A1E29]" />
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

// Unlike displayNum, Daily Limit/Available Limit always show a real
// number — 0 is a meaningful, distinct state (limit fully used, or the
// wallet is Inactive) from "no data", so it's never collapsed into the
// dash. Whole numbers only, same as displayNum.
function displayAvailableLimit(num: number): string {
  const formatted = Math.round(Math.abs(num)).toLocaleString('en-PH');
  return num < 0 ? `-${formatted}` : formatted;
}

// The SDP column's own headline value — this wallet's own allocated share
// (per explicit instruction, not the shop-level total, which stays
// available only via the tooltip's own breakdown). null (shop has no real
// SDP at all) shows as '−'; a real 0 (wallet is inactive) shows as a
// literal "0", same "0 is meaningful, never collapsed to a dash"
// convention displayAvailableLimit already uses for Daily/Available Limit.
function sdpAllocationDisplay(row: WalletStatusRow): string {
  return row.sdpAllocation === null ? '−' : displayAvailableLimit(row.sdpAllocation);
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

// Same abbreviations the old raw Account-derived walletCode always ended
// in ("-BK"/"-NG"/"-RK"/"-UP") — used to rebuild an equivalent key
// (agentCode-suffix) from Postgres's own wallet_types.code, matching the
// Phase 9 re-keyed "Wallet Status" sheet tab format exactly.
const WALLET_TYPE_ABBREVIATIONS: Record<string, string> = { BKASH: 'BK', NAGAD: 'NG', ROCKET: 'RK', UPAY: 'UP' };
// Type column shows the real name (Bkash/Nagad/Rocket/UPay), not the
// abbreviation above — that one's still used for this page's own row
// identity (walletCode, e.g. "JETT003-BK"), untouched.
const WALLET_TYPE_FULL_NAMES: Record<string, string> = { BKASH: 'Bkash', NAGAD: 'Nagad', ROCKET: 'Rocket', UPAY: 'UPay' };

// Same split Transfer Queue's own stripPhonePrefix() (transferQueueService.ts)
// uses — the Balance Limit upload's raw "Account" cell keeps its phone
// number in the DB, but this page's Shop Name column only wants the part
// after it.
function stripPhonePrefix(raw: string): string {
  const idx = raw.indexOf(' - ');
  return idx === -1 ? raw : raw.slice(idx + 3).trim();
}


// Display-only formatting — the sheet stores Leader in raw ALL CAPS
// ("ONEMEN", "MRLEE"); matching/search stay on that raw value (see
// searchedRows), only the rendered text gets Title Cased so it reads as a
// proper name instead of shouting.
function toProperCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Schedule is never staff-entered — derived purely from the Balance Limit
// upload's own real per-wallet Group text (the Balance tab, same source
// Wallet Status itself already reads), not from a Leader lookup table
// (the old approach, replaced per explicit instruction). '' means no
// recognized keyword (renders as a blank cell, never "Unknown"/"N/A"/a
// default).
type Schedule = 'Early Ext.' | 'Extended' | 'Day' | '24/7' | '';

// Checked in this exact order — "Extended"/"Early" always co-occur with
// "Day" in the real Group text (e.g. "SH- Extended Day WD Only"), never
// with "24/7", confirmed against every real distinct Group value on file
// for both products — so checking the more specific keywords first is
// safe and unambiguous.
function deriveScheduleFromGroup(group: string): Schedule {
  const text = group.toUpperCase();
  if (text.includes('EXTENDED')) return 'Extended';
  if (text.includes('EARLY')) return 'Early Ext.';
  if (text.includes('24/7')) return '24/7';
  if (text.includes('DAY')) return 'Day';
  return '';
}

// Sort order per spec: 24/7, Day, Early Ext., Extended, then blank last —
// rank-based lookup, reversible by sort direction.
const SCHEDULE_SORT_ORDER: Schedule[] = ['24/7', 'Day', 'Early Ext.', 'Extended', ''];

// Display-only override — a Wallet With Issue/Disconnected wallet's real
// derived schedule (row.schedule, still used for filtering/sorting/
// search/export) shows as "None", muted, per explicit instruction —
// scheduling a wallet that isn't even open doesn't mean anything.
function scheduleDisplay(row: WalletStatusRow): { text: string; muted: boolean } {
  if (row.walletStatus === 'Wallet With Issue' || row.walletStatus === 'Disconnected') {
    return { text: 'None', muted: true };
  }
  return { text: row.schedule, muted: false };
}
const SCHEDULE_RANK: Record<Schedule, number> = Object.fromEntries(
  SCHEDULE_SORT_ORDER.map((s, i) => [s, i])
) as Record<Schedule, number>;

// Fixed small domains — unlike Leader (open-ended, derived from the roster
// below), Deposit/Withdrawal/Wallet Status only ever take these values.
const DEPOSIT_WITHDRAWAL_OPTIONS: DepositWithdrawal[] = ['Yes', 'No'];
// Filter dropdown list order AND the Wallet Status column's own sort
// priority (see WALLET_STATUS_RANK below) — per explicit instruction.
// Account Problem isn't part of the given order (no real data currently
// uses it — see balanceLimitParser.ts's own header comment) so it's
// appended last rather than dropped, keeping it a real, findable option.
const WALLET_STATUS_FILTER_OPTIONS: WalletStatusValue[] = ['DP + WD', 'DP Only', 'WD Only', 'Top Up Acc.', 'Wallet With Issue', 'Disable', 'Disconnected', 'Account Problem'];
const WALLET_STATUS_RANK: Record<WalletStatusValue, number> = Object.fromEntries(
  WALLET_STATUS_FILTER_OPTIONS.map((s, i) => [s, i])
) as Record<WalletStatusValue, number>;
// Default (initial-load) arrangement's "problem" group — everything else
// counts as "active" for this purpose. Per explicit instruction, distinct
// from WALLET_STATUS_RANK's own full priority order above (which only
// governs an explicit column-header sort click, not the untouched
// default view).
const WALLET_STATUS_DEFAULT_PROBLEM_GROUP = new Set<WalletStatusValue>(['Wallet With Issue', 'Disable', 'Disconnected', 'Account Problem']);
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
  // Abbreviation (BK/NG/RK/UP) — same convention as the Balance page's own
  // Type column (app/agentbal/page.tsx). '−' when unresolved.
  walletType: string;
  leader: string;
  // Always a real number — the Balance Limit upload's own real per-wallet
  // "DP Limit" cell, or 0 when the wallet is Disconnected (see the Daily
  // Limit column rules). Not editable — no staff override exists anymore.
  dailyLimit: number;
  availableLimit: number;
  // This wallet's own share of the shop's total SDP — live-computed via
  // allocateSdpAcrossWallets() (balanceEngine.ts), never persisted; this is
  // the SDP column's own headline value now (see sdpAllocationDisplay,
  // COLUMN_INFO_TEXT.sdp for the rule explanation). null when the shop has
  // no real SDP at all.
  sdpAllocation: number | null;
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  // The wallet's own raw Login flag — distinct from walletStatus, since
  // "Disconnected" can also result from a logged-in wallet with
  // unrecognized/blank Group text (computeWalletStatus's own default
  // fallback), not only Login=No. The Limit Used panel's "Login = Yes
  // only" base filter needs the real flag, not an inference from the
  // displayed status.
  isLoggedIn: boolean;
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
};

const COLUMN_IDS = {
  SHOP_NAME: 'shopName',
  WALLET_TYPE: 'walletType',
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
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.SHOP_NAME, label: 'Shop Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_TYPE, label: 'Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.BALANCE_LIMIT, label: 'Daily Limit', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.AVAILABLE_LIMIT, label: 'Available Limit', visible: true, sortable: true, hideable: true, align: 'right' },
  // SDP column removed entirely — hiding it by default (visible: false,
  // still hideable) wasn't enough since it could still be toggled back on
  // via the Columns dropdown or a stale saved preference. Dropped from
  // DEFAULT_COLUMNS entirely so it can never reappear regardless of prior
  // state.
  { key: COLUMN_IDS.DEPOSIT, label: 'Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WITHDRAWAL, label: 'Withdrawal', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SCHEDULE, label: 'Schedule', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: true, sortable: true, hideable: false, align: 'center' },
  // Independent of Wallet Status/Priority — its own click-to-edit popover,
  // not tied to the row-wide Edit/Save/Cancel below. Fixed width (see
  // computeColumnWidthsPx's own special-case), never measured from content.
  // Always left-aligned (header and data both — see RemarksCell's "No
  // Remarks" placeholder, which used to be inconsistently centered while
  // a real remark was left).
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
// Compact row/column density: font, padding, row height, and badge
// chrome all scaled down together so nothing drifts out of proportion.
const BODY_TEXT_FONT = '400 11px Inter, sans-serif';
const HEADER_TEXT_FONT = '600 12px Inter, sans-serif';
const PILL_BADGE_FONT = '500 11px Inter, sans-serif';

// Chrome/padding/reserve constants trimmed to eliminate 100%-zoom
// overflow — verified against the full live dataset that the longest
// real Shop Name needs 172px of text alone, so Shop Name itself has zero
// slack to give; these constants (pure UI gutter, not text) absorb the
// savings instead. px-[8px] cell padding = 8px each side = 16px total.
const CELL_PADDING_PX = 16;
// Sort icon + its gap reserve, for sortable headers only (see SortIcon).
const HEADER_SORT_ICON_RESERVE_PX = 13;
// Info icon + its gap reserve — Available Limit/Frozen Amount only.
const HEADER_INFO_ICON_RESERVE_PX = 11;
// Deposit/Withdrawal/Priority pill chrome beyond its text: px-[4px] (4px)
// each side + 1px border each side.
const PILL_BADGE_CHROME_PX = 10;
// Wallet Status pill chrome beyond its text: px-[4px] (4px) each side +
// 1px border each side + the status dot + its gap.
const WALLET_STATUS_BADGE_CHROME_PX = 20;
// Extra breathing room so the longest value never sits flush against the
// next column's edge.
const EXTRA_BREATHING_ROOM_PX = 3;
// The Edit/Save/Cancel action column has no measurable text content (icon
// buttons only) — fixed wide enough for the Save+Cancel button pair.
const WALLET_STATUS_ACTION_WIDTH_PX = 54;
// Remarks is free text up to 500 chars — a fixed BASE width (per spec),
// never grown to fit its own content; it still grows via the shared
// flexible-scaling pool up to its COLUMN_LIMITS.remarks.max, same as
// every other flexible column. Bumped +70px (115 -> 185) per explicit
// instruction: the Brand column was removed entirely, and this is the
// same ~69px Brand used to occupy (measured live before removal), handed
// straight to Remarks instead of being spread thin across every column.
const REMARKS_COLUMN_WIDTH_PX = 185;
// Hover delay before the full-remark tooltip appears — long enough that a
// quick pass-over the cell doesn't flash it, per spec.
const REMARKS_TOOLTIP_HOVER_DELAY_MS = 275;

// Per-column min/max px bounds. `min` is a floor only (never causes
// truncation). `max` is a generous safety ceiling for a genuinely
// pathological outlier value — real data in this dataset sits well under
// it, so every real value renders in full, no ellipsis. If an outlier
// ever did exceed it, the table falls back to horizontal scroll (sticky
// checkbox/shop columns) rather than clipping text.
const COLUMN_LIMITS: Partial<Record<ColumnKey, { min: number; max: number }>> = {
  leader: { min: 58, max: 200 },
  shopName: { min: 90, max: 320 },
  walletType: { min: 45, max: 120 },
  balanceLimit: { min: 58, max: 180 },
  availableLimit: { min: 64, max: 190 },
  sdp: { min: 58, max: 180 },
  deposit: { min: 58, max: 120 },
  withdrawal: { min: 58, max: 140 },
  schedule: { min: 58, max: 140 },
  walletStatus: { min: 77, max: 220 },
  // Remarks is back in the shared flexible pool (see scaledColWidthsPx) —
  // capped so it can still gain a fair proportional share of leftover
  // space without growing unbounded on its own. max raised (260 -> 320)
  // to give the new, wider base (REMARKS_COLUMN_WIDTH_PX) room to keep
  // scaling proportionally like every other flexible column.
  remarks: { min: 115, max: 320 },
};

const COLUMNS_WITH_INFO_ICON: ColumnKey[] = ['schedule', 'sdp'];
const PILL_BADGE_COLUMNS: ColumnKey[] = ['deposit', 'withdrawal'];

// Exact display string per column — mirrors renderCell's own per-column
// JSX content, kept as plain strings here purely for width measurement.
function getColumnDisplayText(row: WalletStatusRow, key: ColumnKey): string {
  switch (key) {
    case 'shopName': return row.shopName;
    case 'walletType': return row.walletType;
    case 'leader': return toProperCase(row.leader);
    case 'balanceLimit': return displayAvailableLimit(row.dailyLimit);
    case 'availableLimit': return displayAvailableLimit(row.availableLimit);
    case 'sdp': return sdpAllocationDisplay(row);
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

    const font = (PILL_BADGE_COLUMNS.includes(col.key) || col.key === 'walletStatus') ? PILL_BADGE_FONT
      : BODY_TEXT_FONT;
    const chrome = col.key === 'walletStatus' ? WALLET_STATUS_BADGE_CHROME_PX
      : PILL_BADGE_COLUMNS.includes(col.key) ? PILL_BADGE_CHROME_PX
      : 0;

    let maxTextWidth = 0;
    for (const row of rows) {
      const w = measureTextWidthPx(getColumnDisplayText(row, col.key) ?? '', font);
      if (w > maxTextWidth) maxTextWidth = w;
    }
    const dataWidth = maxTextWidth > 0 ? Math.ceil(maxTextWidth) + chrome + CELL_PADDING_PX + EXTRA_BREATHING_ROOM_PX : 0;

    // `center`-aligned headers reserve the icon group's width TWICE (once
    // as the real icon, once as its invisible mirror-spacer — see the
    // header button JSX), since true text-only centering requires it;
    // every other alignment only needs it once.
    const iconReservePx = (col.sortable ? HEADER_SORT_ICON_RESERVE_PX : 0)
      + (COLUMNS_WITH_INFO_ICON.includes(col.key) ? HEADER_INFO_ICON_RESERVE_PX : 0);
    const headerWidth = Math.ceil(measureTextWidthPx(col.label, HEADER_TEXT_FONT))
      + CELL_PADDING_PX
      + (col.align === 'center' ? iconReservePx * 2 : iconReservePx);

    // +15px each to SDP and Schedule — the 30px reclaimed from Remarks above.
    const width = Math.max(dataWidth, headerWidth) + (col.key === 'sdp' || col.key === 'schedule' ? 15 : 0);
    // Clamp into the column's configured min/max range.
    const limits = COLUMN_LIMITS[col.key];
    const clampedWidth = limits ? Math.min(Math.max(width, limits.min), limits.max) : width;
    if (clampedWidth > 0) result[col.key] = clampedWidth;
  }
  return result;
}

function headerCellClasses(align: 'left' | 'right' | 'center') {
  return `group overflow-hidden whitespace-nowrap px-[8px] text-${align} text-[12px] font-semibold text-[#475569] dark:text-[#9CA3AF]`;
}

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

// Daily Limit/Available Limit have no info tooltip (also drops their
// header icon-reserve requirement — see COLUMNS_WITH_INFO_ICON below).
const COLUMN_INFO_TEXT: Partial<Record<ColumnKey, string>> = {
  schedule: 'Wallet operating schedule.\n\nDay\n7:00 AM – 10:00 PM\n\nExtended\n7:00 AM – 11:00 PM\n\nEarly Ext.\n6:00 AM – 12:00 AM\n\n24/7\nOpen 24 Hours\n\nAutomatically read from this wallet\'s own Balance Limit Group text — not editable. Shows "None" while Wallet With Issue or Disconnected.',
  sdp: "This wallet's own share of the shop's total SDP, split across the shop's active wallets.\n\n80% of SDP splits across active BK/Nagad wallets (50/50 if both active, or all to whichever one is active). 20% splits equally across every other active wallet. Inactive wallets always get 0.",
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
      <Info size={9} />
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
      className="flex h-[22px] w-full max-w-full items-center overflow-hidden"
    >
      {hasRemark ? (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[11px] font-normal text-slate-700 dark:text-slate-300">{remark}</span>
      ) : (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[11px] font-normal italic text-slate-400 dark:text-slate-500">No Remarks</span>
      )}
      {hasTooltipContent && tooltip.rendered && typeof document !== 'undefined' && createPortal(
        // "Premium floating card" per spec — light bg/text in light mode,
        // with dark: variants added (same #2a2a2d/#3a3a3d surface+border
        // pair the app's other floating panels use — FilterDropdown/
        // ColumnsDropdown) per explicit instruction: this previously
        // stayed pure white even in dark mode, reading as a jarring bright
        // card against the rest of the dark UI. Enters with a fade +
        // slight 4px upward lift + scale from 0.97 (never scale(0) —
        // Kowalski: nothing in the real world pops in from nothing); exits
        // the same transition reversed (a true fade-only exit would need a
        // separate exit-only transition definition, not worth the extra
        // complexity for a hover tooltip).
        <div
          ref={tooltip.tooltipRef}
          style={{
            position: 'fixed',
            top: tooltip.pos.top,
            left: tooltip.pos.left,
            transform: `translate(-50%, ${tooltip.open ? '0' : '4px'}) scale(${tooltip.open ? 1 : 0.97})`,
            transformOrigin: tooltip.placement === 'above' ? 'bottom center' : 'top center',
          }}
          className={`pointer-events-none z-[9999] w-[300px] max-w-[90vw] rounded-xl border border-[#E5E7EB] bg-white p-4 text-left shadow-[0_10px_30px_rgba(15,23,42,0.12)] transition-[opacity,transform] duration-200 ease-out dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:shadow-[0_10px_30px_rgba(0,0,0,0.45)] ${tooltip.open ? 'opacity-100' : 'opacity-0'}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] leading-none">📝</span>
            <h3 className="text-[13px] font-semibold text-[#0F172A] dark:text-[#E5E7EB]">Remarks</h3>
          </div>

          <p className="mt-2.5 line-clamp-4 whitespace-pre-line break-words text-[11.5px] font-normal leading-[1.5] text-[#334155] dark:text-[#CBD5E1]">
            {hasRemark ? remark : '—'}
          </p>

          {hasOperationalInfo && (
            <>
              <div className="my-3 border-t border-[#E5E7EB] dark:border-[#3a3a3d]" />
              <div className="space-y-2">
                {hasMainReason && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-[#334155] dark:text-[#CBD5E1]">Main Reason</span>
                    <span className="inline-flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MAIN_REASON_DOT_STYLES[mainReason]}`} />
                      <span className={`inline-flex items-center rounded-full px-2 py-[3px] text-[10.5px] font-medium ${MAIN_REASON_BADGE_STYLES[mainReason]}`}>
                        {mainReason}
                      </span>
                    </span>
                  </div>
                )}
                {hasClosureType && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-[#334155] dark:text-[#CBD5E1]">Closure Type</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-[3px] text-[10.5px] font-medium ${CLOSURE_TYPE_BADGE_STYLES[closureType]}`}>
                      {closureType === 'Temporary Close' ? 'Temporary' : 'Permanent'}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-medium text-[#334155] dark:text-[#CBD5E1]">DP</span>
                  <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium ${depositClosed ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {depositClosed ? <X size={11} /> : <Check size={11} />}
                    {depositClosed ? 'Closed' : 'Open'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-medium text-[#334155] dark:text-[#CBD5E1]">WD</span>
                  <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium ${withdrawalClosed ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {withdrawalClosed ? <X size={11} /> : <Check size={11} />}
                    {withdrawalClosed ? 'Closed' : 'Open'}
                  </span>
                </div>
              </div>
            </>
          )}

          {(updatedBy || updatedAt) && (
            <>
              <div className="my-3 border-t border-[#E5E7EB] dark:border-[#3a3a3d]" />
              <div className="grid grid-cols-2">
                <div>
                  <p className="flex items-center gap-1 text-[9.5px] font-medium text-[#94A3B8] dark:text-[#6B7280]">
                    <span className="leading-none">📅</span> Last Updated
                  </p>
                  <p className="mt-0.5 text-[11px] font-semibold text-[#0F172A] dark:text-[#E5E7EB]">{updatedAt ? formatRemarkTimestamp(updatedAt) : '—'}</p>
                </div>
                <div className="border-l border-[#E5E7EB] pl-3 dark:border-[#3a3a3d]">
                  <p className="flex items-center gap-1 text-[9.5px] font-medium text-[#94A3B8] dark:text-[#6B7280]">
                    <span className="leading-none">👤</span> Edited By
                  </p>
                  <p className="mt-0.5 text-[11px] font-semibold text-[#0F172A] dark:text-[#E5E7EB]">{updatedBy || '—'}</p>
                </div>
              </div>
            </>
          )}
          {/* Pointer arrow — tracks arrowOffsetPercent (not a fixed 50%)
              since horizontal viewport clamping can shift the tooltip away
              from being centered on its trigger; flips to the bottom edge
              pointing down when the tooltip had to flip above the trigger
              instead of its usual below placement. Fill/border follow the
              card's own dark: pair so the arrow never reads as a stray
              white triangle against the dark card. */}
          <span
            style={{ left: `${tooltip.arrowOffsetPercent}%` }}
            className={`absolute h-2 w-2 -translate-x-1/2 rotate-45 border-[#E5E7EB] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d] ${
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
  // Default (initial-load, before the user ever clicks a sort header)
  // arrangement is its own scheme, per explicit instruction — not just
  // "sortColumn=shopName" — see sortedRows below for the actual logic.
  // Flips permanently true on the first sort-header click; filtering does
  // NOT reset it (only an explicit sort interaction ends the default view).
  const [hasUserSorted, setHasUserSorted] = useState(false);
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const exportTooltip = useToolbarTooltip(exportButtonRef);
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
  const [walletTypeFilter, setWalletTypeFilter] = useState<Record<string, boolean>>({});
  const [depositFilter, setDepositFilter] = useState<Record<string, boolean>>({});
  const [withdrawalFilter, setWithdrawalFilter] = useState<Record<string, boolean>>({});
  const [scheduleFilter, setScheduleFilter] = useState<Record<string, boolean>>({});
  const [walletStatusFilter, setWalletStatusFilter] = useState<Record<string, boolean>>({});
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [walletTypeMenuOpen, setWalletTypeMenuOpen] = useState(false);
  const [depositMenuOpen, setDepositMenuOpen] = useState(false);
  const [withdrawalMenuOpen, setWithdrawalMenuOpen] = useState(false);
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const [walletStatusMenuOpen, setWalletStatusMenuOpen] = useState(false);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const walletTypeButtonRef = useRef<HTMLButtonElement>(null);
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
        // Leader/SDP now read PostgreSQL (/api/v2/opening) — the same live
        // source app/summary itself already reads, not the older Sheets
        // mirror (/api/opening) this page used to fall back to. agents.sdp
        // coerces blank/null to 0 (Cashout Opening's own established
        // convention — see openingPageService.ts's own comment); the old
        // Sheets-era "NO SDP" text sentinel has no Postgres equivalent, so
        // sdpNum === 0 is the only signal left for "no real SDP" (same
        // resolution transferQueueService.ts's computeSdpVsBalanceRaw
        // already uses for this exact gap).
        fetch(`/api/v2/opening?t=${Date.now()}`),
        // Phase 9 — live wallet status/financial fields now read PostgreSQL
        // (same Phase 8B endpoint the Balance Tab uses), not Google Sheets.
        // Priority/Remarks/Wallet Settings below stay on the "Wallet Status"
        // sheet tab, unchanged — only its per-wallet KEY format was migrated
        // (Phase 9's own one-time re-key) from a raw Account-derived string
        // to agentCode-walletTypeSuffix, so it now matches what's derivable
        // from Postgres without needing a Sheets call for key derivation.
        fetch(`/api/v2/balance-limit?product=cashout&t=${Date.now()}`),
        fetch(`/api/wallet-status?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, statusRes]);

      const openingRows: { agentCode: string; leader: string; sdp: number }[] = await openingRes.json();
      const balJson: { rows: BalanceLimitWalletRow[] } = await balRes.json();
      const statusData: Record<string, PriorityEntry> = await statusRes.json();

      // Leader/SDP are shop-level (one row per shop) — looked up per wallet
      // below by the shop's own bare code, same value repeated across
      // however many wallets that shop has.
      const leaderByShop = new Map<string, string>();
      const sdpByShop = new Map<string, number>();
      openingRows.forEach((row) => {
        leaderByShop.set(row.agentCode, row.leader);
        sdpByShop.set(row.agentCode, row.sdp);
      });

      // agent_wallets already has one row per WALLET (Bkash/Nagad/Rocket/
      // UPay), not per shop — same granularity the raw "Account" column
      // used to provide. walletCode ("JETT003-BK") is this page's own row
      // IDENTITY (React key + the key Priority/Remarks/Wallet Settings save
      // under) — stays exactly this stable, always-available format, never
      // the raw account text (which can be blank for older rows). displayName
      // is DISPLAY-only — the real Balance Limit account text with its phone
      // number stripped (e.g. "N-M1AG-M1-JETT003-BK", matching Transfer
      // Queue's own Shop Name format), falling back to walletCode for a
      // wallet row written before raw_account existed.
      const balRows = balJson.rows
        .filter((row) => row.agentCode && row.agentCode !== '-')
        .map((row) => {
          const suffix = WALLET_TYPE_ABBREVIATIONS[row.walletType] ?? '';
          const walletCode = suffix ? `${row.agentCode}-${suffix}` : row.agentCode;
          return {
            bareShopName: row.agentCode,
            walletCode,
            displayName: row.rawAccount ? stripPhonePrefix(row.rawAccount) : walletCode,
            walletType: row.walletType,
            totalDP: row.totalDP,
            group: row.group,
            accountStatus: row.accountStatus,
            isLoggedIn: row.isLoggedIn,
            dpLimit: row.dpLimit,
          };
        });

      // Every wallet of a shop needs to be seen together to compute SDP
      // allocation (allocateSdpAcrossWallets needs the shop's FULL active
      // set, not just one row) — built once here, keyed by bareShopName,
      // before the per-row merge below looks up each row's own share.
      const walletsForSdpByShop = new Map<string, SdpAllocationWallet[]>();
      balRows.forEach((bal, index) => {
        const computedStatus = computeWalletStatus([bal.accountStatus]);
        // "Active" for SDP purposes means deposit-or-withdrawal-capable —
        // no longer a single walletStatus value to compare against now
        // that the granular label displays directly (DP+WD/DP Only/etc.),
        // so this checks the flags Deposit/Withdrawal derives from, which
        // are exactly "No"/"No" for every non-capable status (Disable,
        // Wallet With Issue, Account Problem, Disconnected) — same real
        // semantics as before, just no longer keyed off the word "Active".
        const sdpFlags = deriveWalletFlags(bal.isLoggedIn, computedStatus);
        const isActive = sdpFlags.deposit === 'Yes' || sdpFlags.withdrawal === 'Yes';
        const list = walletsForSdpByShop.get(bal.bareShopName) ?? [];
        list.push({ id: index, walletType: bal.walletType, isActive });
        walletsForSdpByShop.set(bal.bareShopName, list);
      });

      const merged: WalletStatusRow[] = balRows.map((bal, index) => {
        const totalDP = bal.totalDP;
        const sdpNum = sdpByShop.get(bal.bareShopName) ?? 0;
        const sdpAllocation = sdpNum === 0 ? null
          : (allocateSdpAcrossWallets(sdpNum, walletsForSdpByShop.get(bal.bareShopName) ?? []).perWallet.find((r) => r.id === index)?.allocation ?? 0);
        // Login is passed separately, not folded into this computeWalletStatus
        // call — see deriveWalletFlags' own comment for why.
        const computedStatus = computeWalletStatus([bal.accountStatus]);
        const flags = deriveWalletFlags(bal.isLoggedIn, computedStatus);
        const priorityEntry = statusData[bal.walletCode.toUpperCase()] ?? DEFAULT_PRIORITY_ENTRY;
        // Every wallet carries its own limit, never pooled with the shop's
        // other wallets — Company Balance/SDP no longer factor in at all.
        // Daily Limit is the Balance Limit upload's own real per-wallet "DP
        // Limit" cell (bal.dpLimit) — no staff override, not editable, per
        // explicit instruction it must always be exactly what the file
        // says. Only a genuinely Disconnected wallet (Login=No)
        // unconditionally shows 0 — every other status (Disable/DP + WD/
        // DP Only/WD Only/Top Up Acc./Wallet With Issue/Account Problem)
        // keeps showing its real DP Limit.
        const dailyLimit = flags.walletStatus === 'Disconnected' ? 0 : bal.dpLimit;
        const availableLimit = Math.max(dailyLimit - totalDP, 0);
        return {
          _id: index,
          key: bal.walletCode,
          shopName: bal.displayName,
          brand: resolveBrand([bal.group], bal.walletCode, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES }),
          walletType: WALLET_TYPE_FULL_NAMES[bal.walletType] ?? '−',
          leader: leaderByShop.get(bal.bareShopName) ?? '−',
          dailyLimit,
          availableLimit,
          sdpAllocation,
          deposit: flags.deposit,
          withdrawal: flags.withdrawal,
          isLoggedIn: bal.isLoggedIn,
          schedule: deriveScheduleFromGroup(bal.group),
          walletStatus: flags.walletStatus,
          remark: priorityEntry.remark,
          remarkUpdatedBy: priorityEntry.updatedBy,
          remarkUpdatedAt: priorityEntry.updatedAt,
          mainReason: priorityEntry.mainReason,
          closureType: priorityEntry.closureType,
          affectedServices: priorityEntry.affectedServices,
          minimumAmountCanTake: priorityEntry.minimumAmountCanTake,
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
  }, [searchTerm, sortColumn, sortDirection, rowsPerPage, leaderFilter, walletTypeFilter, depositFilter, withdrawalFilter, scheduleFilter, walletStatusFilter]);

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

    const minimumAmountCanTake = values.minimumAmountCanTake.trim() === '' ? null : Number(values.minimumAmountCanTake);

    fetch('/api/wallet-status/update-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The API's own shopKey — must stay row.key (the stable
        // agentCode-suffix identity), never row.shopName (now the
        // display-only raw account text; resolveTarget()'s shopKey parser
        // expects exactly the "AGENTCODE-BK" shape).
        shopName: row.key,
        remark: values.remark,
        mainReason: values.mainReason,
        closureType: values.closureType,
        affectedServices: values.affectedServices,
        minimumAmountCanTake,
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
  // Schedule overrides interact with computed fields (effective Schedule)
  // in ways that are simplest to just re-derive from a fresh fetch rather
  // than replicate client-side per row.
  const handleModalSaveBulk = useCallback((updates: Partial<WalletSettingsValues>) => {
    const selectedRows = rows.filter((row) => selectedIds.has(row._id));
    if (selectedRows.length === 0) return;

    const payload = selectedRows.map((row) => ({
      shopName: row.key, // same shopKey requirement as handleModalSave above
      ...(updates.remark !== undefined ? { remark: updates.remark } : {}),
      ...(updates.mainReason !== undefined ? { mainReason: updates.mainReason } : {}),
      ...(updates.closureType !== undefined ? { closureType: updates.closureType } : {}),
      ...(updates.affectedServices !== undefined ? { affectedServices: updates.affectedServices } : {}),
      ...(updates.minimumAmountCanTake !== undefined ? { minimumAmountCanTake: updates.minimumAmountCanTake.trim() === '' ? null : Number(updates.minimumAmountCanTake) } : {}),
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
  const walletTypeOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.walletType))).sort((a, b) => a.localeCompare(b)),
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
  const isWalletTypeChecked = (name: string) => walletTypeFilter[name] !== false;
  const isDepositChecked = (name: string) => depositFilter[name] !== false;
  const isWithdrawalChecked = (name: string) => withdrawalFilter[name] !== false;
  const isScheduleChecked = (name: string) => scheduleFilter[name] !== false;
  const isWalletStatusChecked = (name: string) => walletStatusFilter[name] !== false;

  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const anyWalletTypeUnchecked = walletTypeOptions.some((name) => !isWalletTypeChecked(name));
  const anyDepositUnchecked = depositOptions.some((name) => !isDepositChecked(name));
  const anyWithdrawalUnchecked = withdrawalOptions.some((name) => !isWithdrawalChecked(name));
  const anyScheduleUnchecked = scheduleOptions.some((name) => !isScheduleChecked(name));
  const anyWalletStatusUnchecked = walletStatusOptions.some((name) => !isWalletStatusChecked(name));

  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;
  const selectedWalletTypeCount = walletTypeOptions.filter((name) => isWalletTypeChecked(name)).length;
  const selectedDepositCount = depositOptions.filter((name) => isDepositChecked(name)).length;
  const selectedWithdrawalCount = withdrawalOptions.filter((name) => isWithdrawalChecked(name)).length;
  const selectedScheduleCount = scheduleOptions.filter((name) => isScheduleChecked(name)).length;
  const selectedWalletStatusCount = walletStatusOptions.filter((name) => isWalletStatusChecked(name)).length;

  const anyFilterActive = anyLeaderUnchecked || anyWalletTypeUnchecked || anyDepositUnchecked || anyWithdrawalUnchecked || anyScheduleUnchecked || anyWalletStatusUnchecked;

  const resetAllFilters = useCallback(() => {
    setLeaderFilter({});
    setWalletTypeFilter({});
    setDepositFilter({});
    setWithdrawalFilter({});
    setScheduleFilter({});
    setWalletStatusFilter({});
    setLeaderMenuOpen(false);
    setWalletTypeMenuOpen(false);
    setDepositMenuOpen(false);
    setWithdrawalMenuOpen(false);
    setScheduleMenuOpen(false);
    setWalletStatusMenuOpen(false);
  }, []);

  const leaderFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.leader, (counts.get(row.leader) ?? 0) + 1);
    return leaderOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [searchedRows, walletTypeFilter, walletTypeOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, leaderOptions]);

  const walletTypeFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.walletType, (counts.get(row.walletType) ?? 0) + 1);
    return walletTypeOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, walletTypeOptions]);

  const depositFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.deposit, (counts.get(row.deposit) ?? 0) + 1);
    return depositOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, walletTypeFilter, walletTypeOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, depositOptions]);

  const withdrawalFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.withdrawal, (counts.get(row.withdrawal) ?? 0) + 1);
    return withdrawalOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, walletTypeFilter, walletTypeOptions, depositFilter, depositOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions, withdrawalOptions]);

  const scheduleFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.schedule, (counts.get(row.schedule) ?? 0) + 1);
    return scheduleOptions.map((name) => ({ value: name, label: SCHEDULE_FILTER_LABEL[name], count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, walletTypeFilter, walletTypeOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, walletStatusFilter, walletStatusOptions, scheduleOptions]);

  const walletStatusFilterOptions = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.walletStatus, (counts.get(row.walletStatus) ?? 0) + 1);
    return walletStatusOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [searchedRows, leaderFilter, leaderOptions, walletTypeFilter, walletTypeOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusOptions]);

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) list = list.filter((row) => leaderFilter[row.leader] !== false);
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) list = list.filter((row) => walletTypeFilter[row.walletType] !== false);
    if (depositOptions.some((name) => depositFilter[name] === false)) list = list.filter((row) => depositFilter[row.deposit] !== false);
    if (withdrawalOptions.some((name) => withdrawalFilter[name] === false)) list = list.filter((row) => withdrawalFilter[row.withdrawal] !== false);
    if (scheduleOptions.some((name) => scheduleFilter[name] === false)) list = list.filter((row) => scheduleFilter[row.schedule] !== false);
    if (walletStatusOptions.some((name) => walletStatusFilter[name] === false)) list = list.filter((row) => walletStatusFilter[row.walletStatus] !== false);
    return list;
  }, [searchedRows, leaderFilter, leaderOptions, walletTypeFilter, walletTypeOptions, depositFilter, depositOptions, withdrawalFilter, withdrawalOptions, scheduleFilter, scheduleOptions, walletStatusFilter, walletStatusOptions]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    // Default (initial-load) arrangement — active/open statuses on top,
    // Wallet With Issue/Disable/Disconnected/Account Problem grouped at
    // the bottom, each group sorted alphabetically by Shop Name — per
    // explicit instruction. Only applies until the user clicks any sort
    // header for the first time; from then on the normal per-column sort
    // below takes over permanently for this session.
    if (!hasUserSorted) {
      const normalRows = list.filter((row) => !WALLET_STATUS_DEFAULT_PROBLEM_GROUP.has(row.walletStatus));
      const problemRows = list.filter((row) => WALLET_STATUS_DEFAULT_PROBLEM_GROUP.has(row.walletStatus));
      const byShopName = (a: WalletStatusRow, b: WalletStatusRow) => a.shopName.toLowerCase().localeCompare(b.shopName.toLowerCase());
      normalRows.sort(byShopName);
      problemRows.sort(byShopName);
      return [...normalRows, ...problemRows];
    }
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
          case 'shopName': return row.shopName.toLowerCase();
          case 'walletType': return row.walletType.toLowerCase();
          case 'leader': return row.leader.toLowerCase();
          case 'balanceLimit': return row.dailyLimit;
          case 'availableLimit': return row.availableLimit;
          case 'sdp': return row.sdpAllocation ?? -Infinity;
          case 'deposit': return row.deposit;
          case 'withdrawal': return row.withdrawal;
          case 'schedule': return SCHEDULE_RANK[row.schedule];
          case 'walletStatus': return WALLET_STATUS_RANK[row.walletStatus];
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
  }, [filteredRows, sortColumn, sortDirection, hasUserSorted]);

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

  // Checkbox column is a fixed 28px outside colWidthsPx (its own
  // hardcoded `w-[28px]` th below).
  const CHECKBOX_COLUMN_WIDTH_PX = 28;
  // Proportional grow-to-fill (every flexible column scales up together)
  // for everything except the columns pinned at their bare minimum
  // natural width: Shop Name, Wallet Status (reduced to minimum so
  // Remarks gets more of the shared leftover instead), and Action
  // (icon-only, always fixed). Remarks itself stays in the flexible pool
  // alongside Brand/Leader/Type/etc.
  const scaledColWidthsPx = useMemo(() => {
    const pinned = new Set<ColumnKey>(['shopName', 'walletStatus', 'walletStatusAction']);
    const flexibleCols = visibleColumns.filter((col) => !pinned.has(col.key));
    const flexibleNaturalTotal = flexibleCols.reduce((sum, col) => sum + (colWidthsPx[col.key] ?? 0), 0);
    const pinnedTotal = visibleColumns.reduce((sum, col) => {
      if (col.key === 'shopName') return sum + (colWidthsPx.shopName ?? 0);
      if (col.key === 'walletStatus') return sum + (colWidthsPx.walletStatus ?? 0);
      if (col.key === 'walletStatusAction') return sum + WALLET_STATUS_ACTION_WIDTH_PX;
      return sum;
    }, 0);
    // Canvas-measured text width (colWidthsPx) drifts a few px from
    // actual rendered DOM width per column — harmless on its own, but
    // this subtraction has no self-correcting ratio the way the
    // scale-`factor` below does, so that drift can silently overshoot
    // into a real horizontal-scroll overflow (measured live: up to
    // ~28px). SAFETY_MARGIN_PX trades a few px of unused space for a
    // guarantee against that (zero overflow at 100% browser zoom).
    const SAFETY_MARGIN_PX = 55;
    const available = containerWidth - CHECKBOX_COLUMN_WIDTH_PX - pinnedTotal - SAFETY_MARGIN_PX;
    if (flexibleNaturalTotal <= 0 || available <= flexibleNaturalTotal) return colWidthsPx;
    const factor = available / flexibleNaturalTotal;
    const scaled: Partial<Record<ColumnKey, number>> = { ...colWidthsPx };
    flexibleCols.forEach((col) => {
      const natural = colWidthsPx[col.key];
      if (!natural) return;
      const grown = Math.floor(natural * factor);
      // Never scale a column past its own configured max, even when
      // there's leftover container space to fill — keeps badge/dot/icon
      // proportions balanced instead of one column stretching out.
      const limits = COLUMN_LIMITS[col.key];
      scaled[col.key] = limits ? Math.min(grown, limits.max) : grown;
    });
    return scaled;
  }, [colWidthsPx, visibleColumns, containerWidth]);

  const handleExport = useCallback((rowsOverride?: WalletStatusRow[]) => {
    const getExportValue = (row: WalletStatusRow, key: ColumnKey) => {
      switch (key) {
        case 'shopName': return row.shopName;
        case 'walletType': return row.walletType;
        case 'leader': return toProperCase(row.leader);
        case 'balanceLimit': return row.dailyLimit;
        case 'availableLimit': return row.availableLimit;
        case 'sdp': return row.sdpAllocation ?? 0;
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

  // Sticky cells (checkbox/Shop Name/Action) need their own fully OPAQUE
  // background to correctly occlude the row's other cells scrolling
  // underneath them. No zebra striping here — removed per explicit
  // instruction to match every other table in the app (e.g. Balance),
  // none of which alternate row shade.
  function stickyCellBg(selected: boolean): string {
    // Opaque color-mix blend of --ui-accent (not a literal hex pair) — same
    // hue/opacity the rest of the app's selected-row highlight uses
    // (var(--ui-accent-soft), 8%/12% light/dark), just baked into an opaque
    // result instead of true alpha, for the same sticky-cell-bleed-through
    // reason described above. Replaces a hardcoded #EFF6FF/#1e2a3d pair
    // that didn't match any other table's selected-row color.
    // Dark fallback is #12151D — the DataTable CARD's own dark bg (from
    // DataTable.tsx), not #0A0C11 (the page's dark bg, one shade darker,
    // that sits behind the card). Using the page's shade here previously
    // painted the sticky checkbox/Shop Name/Action columns a visibly
    // different color than the rest of every row — read as zebra/banding
    // even though every row had it, since non-sticky cells stay
    // transparent and show the card's real (lighter) #12151D through.
    if (selected) return 'bg-[color-mix(in_srgb,var(--ui-accent)_8%,white)] dark:bg-[color-mix(in_srgb,var(--ui-accent)_12%,#12151D)]';
    return 'bg-white dark:bg-[#12151D]';
  }

  function renderCell(row: WalletStatusRow, key: ColumnKey, colWidthsPx: Partial<Record<ColumnKey, number>> | undefined) {
    // Vertical-align middle (not top) — row content sits centered within
    // the row rather than flush at the top edge (badges/text have
    // different intrinsic heights, so align-top made rows look visually
    // uneven row to row).
    const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-normal text-center px-[8px] py-[11px] align-middle';
    const shopBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-normal text-left px-[8px] py-[11px] align-middle';
    // Right-aligned variant for numeric columns (Daily Limit, Available
    // Limit). Right padding is NOT symmetric with the left — both of
    // these columns' headers reserve a fixed ~32px gutter on their right
    // edge for the sort+info icon group (the header label's own right
    // edge sits at that inset, not the cell's true edge, so the label
    // itself is never shifted by the icon), so the data's right edge must
    // match that SAME inset, not the cell's true right edge, or the
    // header word and the numbers below it drift out of alignment.
    const rightBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-normal text-right pl-[8px] pr-[40px] py-[11px] align-middle';
    // Daily Limit/Available Limit specifically get the Balance page's own
    // numeric-column size (12.5px/16px leading, per explicit instruction to
    // match that page's figures) — a dedicated variant, not an appended
    // override class, since a later same-specificity Tailwind utility
    // doesn't reliably beat an earlier one in the generated stylesheet.
    const rightBaseLg = 'whitespace-nowrap overflow-hidden text-ellipsis text-[12.5px] leading-[16px] font-normal text-right pl-[8px] pr-[40px] py-[11px] align-middle';
    const width = colWidthsPx?.[key];
    const cellStyle = width ? { width, minWidth: width } : undefined;
    switch (key) {
      case 'shopName': {
        // Pinned left (after the checkbox column) so it stays visible
        // while the rest of the table scrolls horizontally.
        const stickyBg = stickyCellBg(selectedIds.has(row._id));
        return (
          <td key={key} style={cellStyle} className={`${shopBase} text-foreground sticky left-[28px] z-[40] ${stickyBg}`}>
            {row.shopName}
          </td>
        );
      }
      case 'walletType':
        return <td key={key} style={cellStyle} className={`${base} text-foreground`}>{row.walletType}</td>;
      case 'leader':
        return <td key={key} style={cellStyle} className={`${shopBase} text-foreground`}>{toProperCase(row.leader)}</td>;
      case 'balanceLimit':
        return (
          <td key={key} style={cellStyle} className={`${rightBaseLg} tabular-nums text-foreground`}>
            {displayAvailableLimit(row.dailyLimit)}
          </td>
        );
      case 'availableLimit':
        return (
          <td key={key} style={cellStyle} className={`${rightBaseLg} tabular-nums text-foreground`}>
            {displayAvailableLimit(row.availableLimit)}
          </td>
        );
      case 'sdp':
        return <td key={key} style={cellStyle} className={`${rightBase} tabular-nums text-foreground`}>{sdpAllocationDisplay(row)}</td>;
      case 'deposit':
        return (
          <td key={key} style={cellStyle} className={base}>
            <span className={`inline-flex h-[22px] items-center rounded-md border px-[4px] text-[11px] font-medium ${row.deposit === 'Yes'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
              {row.deposit}
            </span>
          </td>
        );
      case 'withdrawal':
        return (
          <td key={key} style={cellStyle} className={base}>
            <span className={`inline-flex h-[22px] items-center rounded-md border px-[4px] text-[11px] font-medium ${row.withdrawal === 'Yes'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}`}>
              {row.withdrawal}
            </span>
          </td>
        );
      case 'schedule': {
        const { text, muted } = scheduleDisplay(row);
        return <td key={key} style={cellStyle} className={`${base} ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{text}</td>;
      }
      case 'walletStatus':
        return (
          <td key={key} style={cellStyle} className={base}>
            <WalletStatusBadge status={row.walletStatus} />
          </td>
        );
      case 'remarks':
        // Uses the shared `cellStyle` (from scaledColWidthsPx), not a
        // hardcoded fixed width — Remarks is the column that absorbs
        // leftover container space (see scaledColWidthsPx), so its
        // rendered width tracks that dynamic value, floored at
        // REMARKS_COLUMN_WIDTH_PX. The remark TEXT itself still never
        // grows/wraps with content (RemarksCell's own truncate+tooltip is
        // unaffected) — only the column's own width is dynamic.
        return (
          <td
            key={key}
            style={cellStyle}
            className={`${shopBase} !overflow-visible`}
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
        const stickyBg = stickyCellBg(selectedIds.has(row._id));
        return (
          <td key={key} style={cellStyle} className={`${base} sticky right-0 z-[40] ${stickyBg}`}>
            <button
              type="button"
              onClick={() => openEditModal(row)}
              aria-label="Edit"
              title="Edit"
              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
            >
              <SquarePen size={12} />
            </button>
          </td>
        );
      }
    }
  }

  return (
    <div className={`wallet-status-page h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#0A0C11] ${manrope.variable} ${spaceGrotesk.variable}`}>
      {/* Page-scoped font override (Manrope/Space Grotesk, matching the
          Balance page's own treatment) — cascades down through
          SettlementHeader too even though that component is shared/
          universal, since it sets no font-family of its own. */}
      <style>{`
        .wallet-status-page {
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .wallet-status-page .tabular-nums {
          font-family: var(--font-space-grotesk), ui-monospace, monospace;
        }
      `}</style>
      {toast && (
        <div className="fixed right-5 top-5 z-[100] flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3.5 py-2.5 text-[12px] font-medium text-foreground shadow-lg dark:border-emerald-900/50 dark:bg-[#12151D]">
          <Check size={15} className="shrink-0 text-emerald-500" />
          {toast}
        </div>
      )}
      <SettlementHeader icon={Flag} title="Wallet Status" isRefreshing={spinning} onRefresh={fetchData} />

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
            {/* Merged into this single container per explicit instruction —
                was its own separate bordered card above the table before.
                Its own border-b (inside the component) is what visually
                separates it from the toolbar/table below, matching the
                border-b the toolbar row itself already uses. */}
            <WalletLimitUsedPanel rows={rows} loading={loading} />
            {saveError && (
              <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-400">
                {saveError}
              </div>
            )}
            {/* Same style/arrangement as Top Up/Settlement (app/topup/page.tsx):
                Filters (mr-3) -> Search (flex-1, rounded-full) -> [Bulk
                Actions, only while rows are selected] -> Actions (ml-3),
                replacing the old Toolbar/Toolbar.Left/Toolbar.Right layout. */}
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-[#E5E7EB] px-[13px] py-[10px] dark:border-[#262B38]">
              {loading ? (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[80px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[90px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[83px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[102px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />
                </div>
              ) : (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
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
                      label="Type"
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

              <div className="flex h-8 flex-1 min-w-[200px] items-center gap-[6px] rounded-full border border-[#E5E7EB] bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:border-[#262B38] dark:bg-[#12151D]">
                {loading ? (
                  <div className="dt-skeleton h-[10px] w-32 rounded-md" />
                ) : (
                  <>
                    <Search size={13} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
                    <input
                      aria-label="Search shop, leader, or brand"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[11px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                      placeholder="Search shop, leader, or brand..."
                    />
                  </>
                )}
              </div>

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

              <div className="ml-[10px] flex shrink-0 items-center gap-[10px]">
                {loading && <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />}
                {!loading && (
                  <div className="relative">
                    <button type="button" ref={exportButtonRef} onClick={() => handleExport()} aria-label="Export to Excel" {...exportTooltip.handlers} className={ICON_BUTTON}>
                      <Download size={13} />
                      <span className="hidden xl:inline">Export</span>
                    </button>
                    {exportTooltip.rendered && <ToolbarTooltip label="Export" open={exportTooltip.open} pos={exportTooltip.pos} onlyWhenCompact />}
                  </div>
                )}
                {loading && <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px]" />}
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
                      <Columns3 size={13} />
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
              {/* Overlay, not in-flow — centers on this outer (bounded,
                  non-scrolling) container instead of the table's own
                  horizontally-scrollable content width. */}
              {loading && <TableLoadingSpinner overlay />}
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#0E1119] border-b border-[#E2E8F0] dark:border-[#262B38] transition-shadow duration-150 ease-out ${isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''}`}>
                    <tr className="h-[38px]">
                      <th className={`${headerCellClasses('center')} w-[28px] sticky left-0 z-[51] bg-[#FAFAFB] dark:bg-[#0E1119]`}>
                        {!loading && (
                          <input
                            type="checkbox"
                            aria-label="Select all rows on this page"
                            checked={allOnPageSelected}
                            onChange={toggleSelectAllOnPage}
                            className="h-[11px] w-[11px] cursor-pointer"
                          />
                        )}
                      </th>
                      {visibleColumns.map((col) => (
                        <th
                          key={col.key}
                          style={scaledColWidthsPx[col.key] ? { width: scaledColWidthsPx[col.key], minWidth: scaledColWidthsPx[col.key] } : undefined}
                          className={`${headerCellClasses(col.align)} ${col.key === 'walletStatusAction' ? 'sticky right-0 z-[51] bg-[#FAFAFB] dark:bg-[#0E1119]' : ''} ${col.key === 'shopName' ? 'sticky left-[28px] z-[51] bg-[#FAFAFB] dark:bg-[#0E1119]' : ''}`}
                        >
                          {loading ? (
                            <div className={`h-[10px] w-3/5 max-w-[58px] dt-skeleton rounded-md ${col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''}`} />
                          ) : col.sortable ? (
                            <button
                              type="button"
                              onClick={() => {
                                setHasUserSorted(true);
                                if (sortColumn === col.key) {
                                  setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setSortColumn(col.key);
                                  setSortDirection('asc');
                                }
                              }}
                              className={`flex w-full items-center gap-1.5 transition hover:opacity-80 ${col.align === 'center' ? 'justify-center' : col.align === 'right' ? 'justify-end' : 'justify-start'}`}
                            >
                              {/* Icon stays in normal flow (never
                                  position:absolute) so it can never be
                                  clipped by the header cell's overflow-hidden
                                  on a tight column. `center` gets an
                                  invisible mirror-spacer so centering is
                                  based on the header WORD's own character
                                  length only, not shifted by the chevron/
                                  info icon's reserved space — costs a
                                  little extra column width (icon reserved
                                  twice) versus the flush technique `right`
                                  uses below. */}
                              {/* No flex-1 on the label — that was a real
                                  bug: whenever a column's rendered width is
                                  wider than the header's own natural need
                                  (i.e. width is DATA-bound, like Wallet
                                  Status's badge), flex-1 stretched the
                                  label's BOX to fill the extra space while
                                  the fixed-width spacer didn't grow to
                                  match, so the (unstretched) text drifted
                                  left of true center with a visible gap
                                  before the icon. Keeping every piece at
                                  its natural size and letting justify-center
                                  center the whole [spacer, label, icon]
                                  group is what actually keeps the label
                                  centered regardless of the column's real
                                  width — spacer and icon are equal width,
                                  so the label sits exactly in the middle. */}
                              {col.align === 'center' && (
                                <span aria-hidden="true" className="invisible flex items-center gap-1.5">
                                  {COLUMN_INFO_TEXT[col.key] && <Info size={10} />}
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              )}
                              <span className="min-w-0 truncate">{col.label}</span>
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
                      // Empty — the loading indicator is the overlay spinner
                      // on the outer container above, not row content here.
                      null
                    ) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                      <tr
                        key={row.key}
                        className={`dt-row-stagger-in border-b border-border last:border-0 transition-[background-color,border-color] duration-150 ease-out hover:bg-muted/10 ${
                          selectedIds.has(row._id) ? 'bg-[color:var(--ui-accent-soft)]' : ''
                        }`}
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                      >
                        <td
                          className={`px-[8px] py-[11px] text-center align-middle sticky left-0 z-[40] ${stickyCellBg(selectedIds.has(row._id))}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.shopName}`}
                            checked={selectedIds.has(row._id)}
                            onChange={() => toggleRowSelection(row._id)}
                            className="h-[11px] w-[11px] cursor-pointer"
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
                  <TableLoadingSpinner minHeight={8 * 90} />
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => {
                    const showShop = visibleColumns.some((c) => c.key === 'shopName');
                    const showWalletType = visibleColumns.some((c) => c.key === 'walletType');
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
                        className={`dt-row-stagger-in relative rounded-xl border p-3.5 pr-9 transition-[background-color,border-color] duration-150 ease-out dark:bg-[#12151D] ${
                          isSelected
                            ? 'border-[var(--ui-accent)]/40 bg-[color:var(--ui-accent-soft)]'
                            : 'border-border bg-white'
                        }`}
                        style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
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
                        {(showShop || showWalletType) && (
                          <div className={`flex items-start justify-between gap-2 ${showLeader ? 'mt-0.5' : ''}`}>
                            {showShop && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.shopName}</p>}
                            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                              {showWalletType && row.walletType}
                            </span>
                          </div>
                        )}
                        {(showBalanceLimit || showAvailableLimit || showSdp) && (
                          <div className={`grid grid-cols-2 gap-2 ${(showShop || showWalletType || showLeader) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                                <p className="text-[13px] font-semibold tabular-nums text-foreground">{sdpAllocationDisplay(row)}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {(showDeposit || showWithdrawal || showSchedule) && (
                          <div className={`flex flex-wrap items-center gap-2 ${(showShop || showWalletType || showLeader || showBalanceLimit || showAvailableLimit || showSdp) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
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
                                <p className={`text-[12px] font-medium ${scheduleDisplay(row).muted ? 'text-muted-foreground' : 'text-foreground'}`}>{scheduleDisplay(row).text}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {showWalletStatus && (
                          <div className={`flex items-center gap-1.5 ${(showShop || showWalletType || showLeader || showBalanceLimit || showAvailableLimit || showSdp || showDeposit || showWithdrawal || showSchedule) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            <p className="text-[9px] font-medium text-muted-foreground">Wallet Status</p>
                            <WalletStatusBadge status={row.walletStatus} />
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
              <CompactTableFooter
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
        </div>
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
