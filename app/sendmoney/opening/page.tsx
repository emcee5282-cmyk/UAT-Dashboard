'use client';

import { useEffect, useState, useCallback, useMemo, useRef, useDeferredValue, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Columns3, ChevronUp, ChevronDown, ChevronsUpDown, Download, BookOpen, RefreshCw,
  MoreVertical, Copy, Pencil, Eye, Trash2, Inbox,
  Upload, Plus, CheckSquare, X, Tag, User, Wallet as WalletIcon, FilterX,
} from 'lucide-react';
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
import BulkImportModal from '@/app/components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '@/app/components/BulkEditModal';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { parseSendMoneyOpeningCsv, parseNullableNumber, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';
import { extractSendMoneyShopName } from '@/app/lib/realShopName';
import { getPreference, setPreference } from '@/app/lib/preferences';
import { SETTLEMENT_BRAND_OPTIONS } from '@/app/lib/topupOptions';
import { fmtAbbrev, exportNum } from '@/app/lib/format';
import type { SendMoneyOpeningPgRow } from '@/app/lib/services/openingPageService';

// Phase 6 — Today's Opening is PostgreSQL-only at runtime (no opt-in flag,
// no Sheets fallback). See app/summary/page.tsx for the same cutover on the
// Cashout product.

// Page-scoped font override (Manrope for body/labels, Space Grotesk for
// tabular-nums), matching Daily Txn Entry's own treatment and Top Up's port
// of it (app/topup/page.tsx) — per explicit instruction, Opening now
// matches Top Up's typeface exactly, not just its font SIZE. Every other
// page keeps Inter.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

// Responsive action buttons (Upload/Export) — icon+text when the viewport
// has room, collapsing to icon-only (40x40, no padding) once space gets
// tight. Copied verbatim from Settlement (app/stlm/page.tsx) so this page's
// toolbar matches its style/arrangement exactly, per explicit instruction.
// Compact sizing (matches Wallet Status/Transfer Queue/Top Up/Settlement/
// Cashout Opening's own density): h-10/rounded-[12px]/text-[13px] scaled
// down to h-8/rounded-[10px]/text-[11px], gap-1.5 -> gap-[5px] — was left
// over at the old full size while those other pages had already migrated,
// per explicit instruction.
const ICON_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Always-icon-only variant (never shows a text label) — Refresh/Columns
// per explicit instruction, tooltip carries the label instead.
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
    <div className="flex items-center gap-[6px] dt-bar-fade-in">
      <span className="flex h-8 shrink-0 items-center gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-[10px] text-[11px] font-medium text-[#475569] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF]">
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
          className="inline-flex h-8 items-center gap-[5px] rounded-[10px] bg-[var(--ui-accent)] px-[10px] text-[11px] font-medium text-white transition-[filter] duration-150 ease-[var(--ease-out-strong)] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)]"
        >
          Bulk Actions
          <ChevronDown size={11} className={`transition-transform duration-150 ease-[var(--ease-in-out-strong)] ${open ? 'rotate-180' : ''}`} />
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

// Toolbar filter trigger — Brand/Leader/Wallet Type. Trigger only; the
// panel beneath it is the shared FilterDropdown (app/components/
// FilterDropdown.tsx). Copied verbatim from Balance (app/agentbal/page.tsx).
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

// Type comes straight from the wallet name's own suffix, not a separate
// Balance Limit lookup — every Send Money shop is solo (one wallet per
// network), so each row's own agentName already carries its type, e.g.
// "N-T1PS2-NAVY040-NG" -> "NG". Copied verbatim from Balance
// (app/sendmoney/balances/page.tsx), confirmed by sampling every suffix in
// the roster: only NG/RK/UP/BK ever appear.
const WALLET_TYPE_SUFFIXES = ['NG', 'RK', 'UP', 'BK'];

function computeWalletType(agentName: string): string {
  const segments = agentName.trim().toUpperCase().split('-');
  const suffix = segments[segments.length - 1];
  return WALLET_TYPE_SUFFIXES.includes(suffix) ? suffix : '−';
}

const WALLET_TYPE_FILTER_OPTIONS = [
  { label: 'Bkash', abbreviation: 'BK' },
  { label: 'Nagad', abbreviation: 'NG' },
  { label: 'Rocket', abbreviation: 'RK' },
  { label: 'UPay', abbreviation: 'UP' },
];
const WALLET_TYPE_FILTER_LABELS = [...WALLET_TYPE_FILTER_OPTIONS.map((opt) => opt.label), '-'];

// Single badge (never multiple — each Send Money shop has exactly one
// wallet type, unlike Cashout's own multi-wallet-per-shop model) using the
// same per-wallet tint scheme as WALLET_BADGE_TINTS elsewhere (Bkash pink,
// Nagad yellow, Rocket purple, Upay red), keyed by abbreviation.
const WALLET_TYPE_BADGE_TINTS: Record<string, string> = {
  BK: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-900/50',
  NG: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-900/50',
  RK: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  UP: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/50',
};

const WALLET_TYPE_FULL_NAMES: Record<string, string> = {
  BK: 'Bkash',
  NG: 'Nagad',
  RK: 'Rocket',
  UP: 'Upay',
};

function WalletTypeBadge({ walletType }: { walletType: string }) {
  if (!walletType || walletType === '−') {
    return <span className="text-[#94A3B8]">−</span>;
  }
  const tint = WALLET_TYPE_BADGE_TINTS[walletType] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
  return (
    <span className={`inline-flex h-[22px] items-center rounded-[999px] border px-[8px] text-[11px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${tint}`}>
      {WALLET_TYPE_FULL_NAMES[walletType] ?? walletType}
    </span>
  );
}


const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#262B38] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-[color:var(--ui-accent)] px-4 text-[13px] font-medium text-white transition-colors hover:opacity-90';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

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

// Source data comes in as raw uppercase (e.g. "AIMAN") — proper-cased for
// display only (Leader), copied verbatim from Cashout Balance's own
// toProperCase (app/agentbal/page.tsx).
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Zero and "not set" (blank/null source cell) both render as the same dash —
// visually identical to Cashout's fmt(), but null stays a distinct value
// upstream (see app/lib/sendMoneyOpening.ts) for counts/sums that need to
// tell "no opening balance" apart from "opening balance of exactly 0".
function fmt(value: number | null): string {
  if (value === null || value === 0) return '-';
  const formatted = Math.abs(value).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-${formatted}` : formatted;
}

const LAST_UPLOAD_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "September 20, 2026 11:21 AM" — header's "Last update" indicator, same
// format/construction as Cashout's own Opening page (app/summary/page.tsx).
function formatLastOpeningUpload(date: Date): string {
  const month = LAST_UPLOAD_MONTH_NAMES[date.getMonth()];
  const hours24 = date.getHours();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${date.getDate()}, ${date.getFullYear()} ${hours12}:${minutes} ${ampm}`;
}

// Re-triggers a short opacity+translateY fade whenever `value` changes,
// matching Cashout Opening's own (app/summary/page.tsx) bespoke FadeValue —
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

// isActive is Postgres-only (Opening's daily-upload Missing Shops review,
// Phase 3) — added here rather than on the shared SendMoneyOpeningRow type
// since that type is also the legacy CSV-parse shape (parseSendMoneyOpeningCsv,
// unused on this page's own PG-backed fetchData, kept only as an import for
// its type), which has no equivalent concept.
type Row = SendMoneyOpeningRow & { _id: number; walletType: string; isActive: boolean };

const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  AGENT_NAME: 'agentName',
  WALLET_TYPE: 'walletType',
  OPENING_BALANCE: 'openingBalance',
  SECURITY_DEPOSIT: 'securityDeposit',
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

// Alignment matches Cashout Opening's own convention (both ported together):
// text left, numbers right, actions center. Wallet Type center-aligned,
// same as Cashout's own (app/summary/page.tsx).
const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_TYPE, label: 'Wallet Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.OPENING_BALANCE, label: 'Opening Balance', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.SECURITY_DEPOSIT, label: 'Security Deposit', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyOpeningColumnVisibility';

// Kept identical to Cashout Opening's own columnWidths (app/summary/page.tsx)
// so both products' tables render with the same proportions.
const columnWidths: Record<ColumnKey, string> = {
  brand: '14%',
  leader: '16%',
  agentName: '16%',
  walletType: '12%',
  openingBalance: '16%',
  securityDeposit: '15%',
  actions: '11%',
};

const TABLE_MIN_WIDTH_PX = 900;

// Size/weight/case matched to Top Up's own table header cells
// (app/topup/page.tsx: text-[11.5px] font-bold uppercase tracking-[0.03em])
// per explicit instruction.
function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-[8px]') {
  return `group ${paddingCls} text-[11.5px] leading-[20px] font-bold uppercase tracking-[0.03em] text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap text-${align}`;
}

// Row actions menu (⋮) — copied from Settlement/Top Up/Cashout Opening.
function RowActionsCell({ row, onEdit, onDelete }: { row: Row; onEdit: (row: Row) => void; onDelete: (row: Row) => void }) {
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
      `Brand: ${row.brand ?? '-'}`,
      `Leader: ${toProperCase(row.leader)}`,
      `Agent Name: ${row.agentName}`,
      `Wallet Type: ${row.walletType}`,
      `Opening Balance: ${fmt(row.openingBalance)}`,
      `Security Deposit: ${fmt(row.securityDeposit)}`,
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
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#94A3B8] transition-colors duration-150 hover:bg-[#F1F5F9] hover:text-[#475569] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] dark:hover:bg-white/5"
      >
        <MoreVertical size={16} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="z-[9999] w-36 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl dark:border-[#262B38] dark:bg-[#12151D]"
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
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
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
// Top Up); Wallet Type keeps its badge.
function renderCell(row: Row, key: ColumnKey, onEdit: (row: Row) => void, onDelete: (row: Row) => void, searchTerm: string) {
  const align = DEFAULT_COLUMNS.find((c) => c.key === key)?.align ?? 'left';
  // 'right'-aligned columns (Opening Balance, Security Deposit) get extra
  // right padding (28px vs the usual 8px) mirroring the header's own
  // reserved space — matches Top Up exactly.
  const rightPad = align === 'right' ? 'pl-[8px] pr-[28px]' : 'px-[8px]';
  const cellCls = `whitespace-nowrap overflow-hidden text-ellipsis ${rightPad} text-${align} text-[12.5px] leading-[16px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  const base = `${cellCls} py-[6px]`;
  switch (key) {
    case 'brand':
      return <td key={key} title={row.brand ?? '-'} className={base}>{highlightMatch(row.brand ?? '-', searchTerm)}</td>;
    case 'leader':
      return <td key={key} title={toProperCase(row.leader)} className={base}>{highlightMatch(toProperCase(row.leader), searchTerm)}</td>;
    case 'agentName':
      return (
        <td key={key} title={row.agentName} className={base}>
          {highlightMatch(row.agentName, searchTerm)}
          {!row.isActive && (
            <span className="ml-1.5 rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted text-muted-foreground align-middle">Inactive</span>
          )}
        </td>
      );
    case 'walletType':
      return <td key={key} title={row.walletType} className={base}><WalletTypeBadge walletType={row.walletType} /></td>;
    // Normal weight, not bold — a single row's own balance/deposit, not a
    // total/sum. Bold is reserved for genuine totals (e.g. the stat bar's
    // Total Opening Balance/Total SDP above), per explicit instruction.
    case 'openingBalance':
      return <td key={key} className={`${base} tabular-nums ${(row.openingBalance ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{highlightMatch(fmt(row.openingBalance), searchTerm)}</td>;
    case 'securityDeposit':
      return <td key={key} className={`${base} tabular-nums ${(row.securityDeposit ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{highlightMatch(fmt(row.securityDeposit), searchTerm)}</td>;
    case 'actions':
      // py-[2px] (not the shared py-[6px]) — a real <tr>'s `height` is only
      // a CSS minimum, not a cap, so the 32px kebab button needs tight
      // padding here to actually fit inside the target 36px row instead of
      // silently forcing every row taller (confirmed via live measurement:
      // py-[4px] here alone pushed real rows to 41px despite the tr's own
      // h-[36px]).
      return <td key={key} className={`${cellCls} py-[2px]`}><span className="flex items-center justify-center"><RowActionsCell row={row} onEdit={onEdit} onDelete={onDelete} /></span></td>;
    default:
      return null;
  }
}

function compareNullableNumber(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  // Opening's own last completed import (import_batches, importType
  // 'opening') — header's "Last update" indicator, same as Cashout's own
  // Opening page (app/summary/page.tsx).
  const [lastOpeningUpload, setLastOpeningUpload] = useState<Date | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('leader');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const uploadTooltip = useTooltip(uploadButtonRef);
  const newTooltip = useTooltip(newButtonRef);
  const refreshTooltip = useTooltip(refreshButtonRef);
  const exportTooltip = useTooltip(exportButtonRef);
  const columnsTooltip = useTooltip(columnsButtonRef);

  // Toolbar filters — Brand/Leader/Wallet Type, same style/arrangement as
  // Balance (app/agentbal/page.tsx).
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [walletTypeFilter, setWalletTypeFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [walletTypeMenuOpen, setWalletTypeMenuOpen] = useState(false);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const walletTypeButtonRef = useRef<HTMLButtonElement>(null);

  const [editingRow, setEditingRow] = useState<Row | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [deletingRow, setDeletingRow] = useState<Row | null>(null);

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
    const MIN_SPIN_MS = 600;
    const startedAt = Date.now();
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);

      // Today's Opening — PostgreSQL runtime source (Phase 6).
      // /api/v2/sendmoney/opening preserves the null-vs-zero distinction this
      // page's data model requires (see openingPageService.ts's own comment);
      // brand already resolved server-side. walletType stays the page's own
      // existing name-suffix computation, unchanged, just fed agentCode
      // instead of the Sheets-derived agentName.
      const [res, lastUploadRes] = await Promise.all([
        fetch(`/api/v2/sendmoney/opening?t=${Date.now()}`),
        fetch(`/api/v2/sendmoney/opening/last-upload?t=${Date.now()}`),
      ]);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const pgRows: SendMoneyOpeningPgRow[] = await res.json();
      if (lastUploadRes.ok) {
        const { lastOpeningUpload: lastOpeningUploadStr }: { lastOpeningUpload: string | null } = await lastUploadRes.json();
        setLastOpeningUpload(lastOpeningUploadStr ? new Date(lastOpeningUploadStr) : null);
      }
      setRows(
        pgRows.map((r, index) => ({
          agentName: r.agentCode,
          leader: r.leader,
          brand: r.brand,
          openingBalance: r.openingBalance,
          securityDeposit: r.securityDeposit,
          _id: index,
          walletType: computeWalletType(r.agentCode),
          isActive: r.isActive,
        }))
      );
      setSelectedIds(new Set());
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      const remaining = MIN_SPIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
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

  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );

  // Deferred — typing drives searchTerm (and the input's own displayed
  // value) instantly every keystroke, but the expensive filter/facet/sort
  // pipeline below re-runs off this lower-priority value instead. Without
  // it, each keystroke synchronously re-filters+re-sorts ~12,700 rows
  // (multiple full passes: filteredRows, facet options, sortedRows) before
  // React can commit the next character, which reads as the search bar
  // "hanging" for a beat before text appears. React schedules the deferred
  // recompute after the input paints, so typing stays responsive even while
  // the heavy pass is still catching up.
  const deferredSearchTerm = useDeferredValue(searchTerm);

  // Memoized — same fix as app/summary/page.tsx's filteredRows (Cashout
  // Opening's own toolbar-hover-tanks-the-table bug): an unmemoized filter
  // here fed downstream useMemo blocks a fresh array reference on every
  // render, defeating their memoization and re-running the full filter/sort
  // pipeline on every toolbar tooltip hover. Invisible at small row counts,
  // real at this page's ~12,700-row scale.
  const filteredRows = useMemo(() => rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${row.walletType} ${fmt(row.openingBalance)} ${fmt(row.securityDeposit)} ${row.brand ?? ''}`.toLowerCase();
    return haystack.includes(deferredSearchTerm.toLowerCase());
  }), [rows, deferredSearchTerm]);

  // Toolbar filters — Brand/Leader/Wallet Type, same style/arrangement as
  // Balance (app/agentbal/page.tsx). Wallet Type here is single-value per
  // row (one wallet per shop) — simpler exact-match logic than Cashout
  // Opening's own multi-value version, matching Send Money Balance's own
  // Wallet Type filter (app/sendmoney/balances/page.tsx).
  const brandOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.brand ?? '-'))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const leaderOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const walletTypeOptions = WALLET_TYPE_FILTER_LABELS;

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const isWalletTypeChecked = (name: string) => walletTypeFilter[name] !== false;

  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const anyWalletTypeUnchecked = walletTypeOptions.some((name) => !isWalletTypeChecked(name));

  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;
  const selectedWalletTypeCount = walletTypeOptions.filter((name) => isWalletTypeChecked(name)).length;

  const anyFilterActive = anyBrandUnchecked || anyLeaderUnchecked || anyWalletTypeUnchecked;

  const resetAllFilters = useCallback(() => {
    setBrandFilter({});
    setLeaderFilter({});
    setWalletTypeFilter({});
    setBrandMenuOpen(false);
    setLeaderMenuOpen(false);
    setWalletTypeMenuOpen(false);
  }, []);

  const matchesWalletTypeFilter = useCallback((row: Row) => {
    if (!walletTypeOptions.some((name) => walletTypeFilter[name] === false)) return true;
    if (row.walletType === '−') return isWalletTypeChecked('-');
    const opt = WALLET_TYPE_FILTER_OPTIONS.find((o) => o.abbreviation === row.walletType);
    return opt ? isWalletTypeChecked(opt.label) : isWalletTypeChecked('-');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletTypeFilter, walletTypeOptions]);

  const facetFilteredRows = useMemo(() => {
    let list = filteredRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand ?? '-'] !== false);
    }
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    list = list.filter(matchesWalletTypeFilter);
    return list;
  }, [filteredRows, brandFilter, brandOptions, leaderFilter, leaderOptions, matchesWalletTypeFilter]);

  // Faceted option counts — each omits its own facet's clause so unchecking
  // an option in a dropdown doesn't shrink its own list toward zero.
  const brandFilterOptions = useMemo(() => {
    let list = filteredRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    list = list.filter(matchesWalletTypeFilter);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.brand ?? '-', (counts.get(row.brand ?? '-') ?? 0) + 1);
    return brandOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [filteredRows, leaderFilter, leaderOptions, matchesWalletTypeFilter, brandOptions]);

  const leaderFilterOptions = useMemo(() => {
    let list = filteredRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand ?? '-'] !== false);
    }
    list = list.filter(matchesWalletTypeFilter);
    const counts = new Map<string, number>();
    for (const row of list) counts.set(row.leader, (counts.get(row.leader) ?? 0) + 1);
    return leaderOptions.map((name) => ({ value: name, label: toProperCase(name), count: counts.get(name) ?? 0 }));
  }, [filteredRows, brandFilter, brandOptions, matchesWalletTypeFilter, leaderOptions]);

  const walletTypeFilterOptions = useMemo(() => {
    let list = filteredRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand ?? '-'] !== false);
    }
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    const counts = new Map<string, number>();
    for (const row of list) {
      if (row.walletType === '−') {
        counts.set('-', (counts.get('-') ?? 0) + 1);
        continue;
      }
      const opt = WALLET_TYPE_FILTER_OPTIONS.find((o) => o.abbreviation === row.walletType);
      counts.set(opt ? opt.label : '-', (counts.get(opt ? opt.label : '-') ?? 0) + 1);
    }
    return walletTypeOptions.map((name) => ({ value: name, label: name, count: counts.get(name) ?? 0 }));
  }, [filteredRows, brandFilter, brandOptions, leaderFilter, leaderOptions, walletTypeOptions]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return facetFilteredRows;
    const list = [...facetFilteredRows];
    list.sort((a, b) => {
      if (sortColumn === 'openingBalance' || sortColumn === 'securityDeposit') {
        return compareNullableNumber(a[sortColumn], b[sortColumn], sortDirection);
      }
      const getValue = (row: Row) => {
        switch (sortColumn) {
          case 'brand':
            return (row.brand ?? '').toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'agentName':
            return row.agentName.toLowerCase();
          case 'walletType':
            return row.walletType.toLowerCase();
          default:
            return '';
        }
      };
      const comparison = getValue(a).localeCompare(getValue(b));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [facetFilteredRows, sortColumn, sortDirection]);

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

  // Single Edit and Bulk Edit both write through this: agentCode is the
  // stable PostgreSQL lookup key (agents.agent_code), never the edited
  // "Agent Name" field text — renaming an agent isn't supported by this
  // Action, per explicit scoping (see final report). Any edit to that field
  // is not sent and reverts to the real value on the refetch below.
  const patchOpeningAgents = useCallback(async (agentCodes: string[], updates: { leader?: string; brand?: string; openingBalance?: string; sdp?: string }) => {
    const res = await fetch('/api/v2/sendmoney/opening', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCodes, updates }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with status ${res.status}`);
    }
    await fetchData();
  }, [fetchData]);

  const handleEditSave = useCallback(async (agentCode: string, values: Record<string, string>) => {
    await patchOpeningAgents([agentCode], {
      leader: values.leader,
      brand: values.brand,
      openingBalance: values.openingBalance,
      sdp: values.sdp,
    });
  }, [patchOpeningAgents]);

  const handleBulkEditApply = useCallback(async (updates: BulkEditUpdates) => {
    const agentCodes = rows.filter((row) => selectedIds.has(row._id)).map((row) => row.agentName);
    await patchOpeningAgents(agentCodes, {
      ...(updates.leader !== undefined ? { leader: updates.leader } : {}),
      ...(updates.openingBalance !== undefined ? { openingBalance: updates.openingBalance } : {}),
      ...(updates.sdp !== undefined ? { sdp: updates.sdp } : {}),
    });
    setBulkEditOpen(false);
    setSelectedIds(new Set());
  }, [rows, selectedIds, patchOpeningAgents]);

  const handleConfirmDelete = useCallback(async (agentCode: string) => {
    const res = await fetch('/api/v2/sendmoney/opening', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCode }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with status ${res.status}`);
    }
    setSelectedIds(new Set());
    await fetchData();
  }, [fetchData]);

  const handleCreateSave = useCallback(async (values: Record<string, string>) => {
    const res = await fetch('/api/v2/sendmoney/opening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentCode: values.agentName,
        leader: values.leader,
        brand: values.brand,
        openingBalance: values.openingBalance,
        sdp: values.sdp,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with status ${res.status}`);
    }
    await fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const openingRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: [...SETTLEMENT_BRAND_OPTIONS, 'SH'], required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'text', required: true },
    { key: 'leader', label: 'Leader', kind: 'text' },
    { key: 'openingBalance', label: 'Opening Balance', kind: 'amount' },
    { key: 'sdp', label: 'SDP', kind: 'amount' },
  ], []);

  // Optional `rowsOverride`/`fileTag` let the Bulk Actions dropdown's own
  // "Export Selected" reuse this same export path against just the
  // checked rows, instead of duplicating the worksheet-building logic.
  const handleExport = useCallback((rowsOverride?: Row[], fileTag: string = 'OPENING_BALANCE') => {
    const getExportValue = (row: Row, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand ?? '-';
        case 'leader':
          return row.leader;
        case 'agentName':
          return row.agentName;
        case 'walletType':
          return row.walletType;
        case 'openingBalance':
          return exportNum(row.openingBalance);
        case 'securityDeposit':
          return exportNum(row.securityDeposit);
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
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Opening Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_${fileTag}_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const handleExportSelected = useCallback(() => {
    const selectedRows = sortedRows.filter((row) => selectedIds.has(row._id));
    handleExport(selectedRows, 'OPENING_BALANCE_SELECTED');
  }, [sortedRows, selectedIds, handleExport]);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Compact horizontal stat bar — replaces the earlier 4-card icon KPI row
  // (too much empty space for how little each one held), matching Top Up's
  // own redesign (app/topup/page.tsx) exactly, mirroring Cashout Opening
  // (app/summary/page.tsx). Same 4 figures as before — Total Accounts,
  // Total Opening Balance (abbreviated + full-figure subtitle, via this
  // file's own nullable-aware fmt() — blank≠0 here, unlike Cashout's
  // Opening Bal/SDP), Total SDP (same), No Opening Yet — just inline in one
  // thin row instead of separate bordered/icon cards. No delta chip: opening
  // balances are a snapshot, not a daily transaction total.
  const kpis = useMemo(() => {
    const totalOpening = rows.reduce((sum, row) => sum + (row.openingBalance ?? 0), 0);
    const totalSdp = rows.reduce((sum, row) => sum + (row.securityDeposit ?? 0), 0);
    return [
      {
        label: 'Total Accounts',
        bigValue: rows.length.toLocaleString('en-US'), subtitle: undefined as string | undefined,
      },
      {
        label: 'Total Opening Balance',
        bigValue: fmtAbbrev(totalOpening), subtitle: fmt(totalOpening) as string | undefined,
      },
      {
        label: 'Total SDP',
        bigValue: fmtAbbrev(totalSdp), subtitle: fmt(totalSdp) as string | undefined,
      },
      {
        label: 'No Opening Yet',
        bigValue: rows.filter((row) => row.openingBalance === null).length.toLocaleString('en-US'), subtitle: undefined as string | undefined,
      },
    ];
  }, [rows]);

  const hasAnyRecords = rows.length > 0;
  const emptyStateNode = !hasAnyRecords ? (
    <EmptyState
      icon={Inbox}
      title="No Accounts"
      description="Accounts will appear here once they are created or imported."
      action={
        <button type="button" onClick={() => setNewRecordOpen(true)} className={EMPTY_STATE_PRIMARY_BUTTON}>
          Add Record
        </button>
      }
    />
  ) : (
    <EmptyState
      title="No matching agents found."
      description="Try changing your search or filters."
      action={
        <button type="button" onClick={clearSearch} className={EMPTY_STATE_ACTION_BUTTON}>
          Clear Search
        </button>
      }
    />
  );

  return (
    <div className={`opening-page h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#0A0C11] ${manrope.variable} ${spaceGrotesk.variable}`}>
      {/* Page-scoped font override (Manrope/Space Grotesk, matching Daily
          Txn Entry's own treatment) — cascades down through SettlementHeader
          too even though that component is shared/universal, since it sets
          no font-family of its own. Every other page using SettlementHeader
          stays on Inter, unaffected. */}
      <style>{`
        .opening-page {
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .opening-page .tabular-nums {
          font-family: var(--font-space-grotesk), ui-monospace, monospace;
        }
      `}</style>
      <SettlementHeader
        icon={BookOpen}
        title="Opening"
        isRefreshing={spinning}
        onRefresh={fetchData}
        titleExtra={
          lastOpeningUpload && (
            <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
              Last update: <span className="font-[500]! tabular-nums">{formatLastOpeningUpload(lastOpeningUpload)}</span>
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
            {/* Compact horizontal stat bar — now lives INSIDE the same
                bordered card as the toolbar/table (was previously a
                separate full-width band above <main>), matching Top Up's
                own merged-container pattern (app/topup/page.tsx) exactly. */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-border px-[13px] py-[10px]">
              {loading ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-20 dt-skeleton rounded-md" />
                    <div className="h-4 w-10 dt-skeleton rounded-md" />
                  </div>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2 border-l border-border pl-6">
                      <div className="h-2.5 w-20 dt-skeleton rounded-md" />
                      <div className="h-4 w-16 dt-skeleton rounded-md" />
                    </div>
                  ))}
                </>
              ) : (
                kpis.map((kpi, i) => (
                  <div key={kpi.label} className={`flex shrink-0 items-baseline gap-2 ${i > 0 ? 'border-l border-border pl-6' : ''}`}>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{kpi.label}</span>
                    <FadeValue value={kpi.bigValue} className="text-[14px] font-semibold tabular-nums text-foreground" />
                    {kpi.subtitle && (
                      <span className="text-[11px] tabular-nums text-muted-foreground">({kpi.subtitle})</span>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="flex shrink-0 flex-nowrap items-center overflow-x-auto border-b border-border px-[13px] py-[10px]">
              {loading ? (
                <div className="mr-[10px] flex shrink-0 items-center gap-[10px]">
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[74px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[80px]" />
                  <div className="h-8 w-8 shrink-0 dt-skeleton rounded-[10px] xl:w-[104px]" />
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
                      icon={WalletIcon}
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
                      aria-label="Search agents or brands"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="flex-1 bg-transparent text-[11px] font-normal text-foreground placeholder:text-muted-foreground outline-none border-none"
                      placeholder="Search agents or brands..."
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
                    <button type="button" ref={refreshButtonRef} onClick={fetchData} aria-label="Refresh Data" {...refreshTooltip.handlers} className={REFRESH_ICON_BUTTON}>
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
                      aria-controls="sendmoney-opening-columns-popover"
                      aria-label="Customize Columns"
                      {...columnsTooltip.handlers}
                      className={ICON_ONLY_BUTTON}
                    >
                      <Columns3 size={13} />
                    </button>
                    {columnsTooltip.rendered && <Tooltip label="Customize Columns" open={columnsTooltip.open} pos={columnsTooltip.pos} />}
                    <ColumnsDropdown
                      id="sendmoney-opening-columns-popover"
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
            {/* Overlay, not in-flow — centers on this outer (bounded,
                non-scrolling) container instead of the table's own
                horizontally-scrollable content width. */}
            {loading && <TableLoadingSpinner overlay />}
            <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
              <table className="w-full table-fixed text-sm" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                <colgroup>
                  <col style={{ width: '44px' }} />
                  {visibleColumns.map((col) => (
                    <col
                      key={col.key}
                      style={{ width: col.key === COLUMN_IDS.BRAND ? `max(90px, calc(${columnWidths[col.key]} - 44px))` : columnWidths[col.key] }}
                    />
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
                        style={{ width: columnWidths[col.key] }}
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
                          // ("Action", not "ACTION"). This plain <span> has
                          // no such reset, so it would otherwise be the only
                          // header actually rendering uppercase — this keeps
                          // it visually matching the rest.
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
                    const isChecked = selectedIds.has(row._id);
                    return (
                      <tr
                        key={row.agentName || i}
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
                  <TableLoadingSpinner minHeight={8 * 90} />
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => (
                    <div
                      key={row.agentName || i}
                      className="dt-row-stagger-in rounded-xl border border-border bg-white p-3.5 dark:bg-[#12151D]"
                      style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">
                            {row.agentName}
                            {!row.isActive && (
                              <span className="ml-1.5 rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted text-muted-foreground align-middle">Inactive</span>
                            )}
                          </p>
                          <p className="truncate text-[12px] font-normal text-muted-foreground">{toProperCase(row.leader)}{row.brand ? ` · ${row.brand}` : ''}{row.walletType !== '−' ? ` · ${row.walletType}` : ''}</p>
                        </div>
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground">Opening Balance</p>
                          <p className={`text-sm font-bold tabular-nums ${(row.openingBalance ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{fmt(row.openingBalance)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground">Security Deposit</p>
                          <p className={`text-sm font-bold tabular-nums ${(row.securityDeposit ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{fmt(row.securityDeposit)}</p>
                        </div>
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

      <RecordFormModal
        isOpen={editingRow !== null}
        onClose={() => setEditingRow(null)}
        title="Edit Account"
        subtitle="Update this wallet's account details"
        fields={openingRecordFields}
        initialValues={editingRow ? {
          brand: editingRow.brand ?? '',
          agentName: editingRow.agentName,
          leader: editingRow.leader,
          openingBalance: editingRow.openingBalance !== null ? String(editingRow.openingBalance) : '',
          sdp: editingRow.securityDeposit !== null ? String(editingRow.securityDeposit) : '',
        } : {}}
        onSave={editingRow ? (values) => handleEditSave(editingRow.agentName, values) : undefined}
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <ConfirmDeleteModal
        isOpen={deletingRow !== null}
        onClose={() => setDeletingRow(null)}
        onConfirm={() => handleConfirmDelete(deletingRow!.agentName)}
        title="Delete Wallet?"
        subject={deletingRow?.agentName ?? ''}
        primaryButtonClassName="bg-rose-600 hover:bg-rose-700"
        dataProduct="sendmoney"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        title="New Account"
        subtitle="Add a wallet under an existing brand"
        fields={openingRecordFields}
        initialValues={{}}
        onSave={handleCreateSave}
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        moduleLabel="Opening Balance Accounts"
        templateModule="openingSendMoney"
        moduleKind="opening"
        accentButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
        brandOptions={[...SETTLEMENT_BRAND_OPTIONS, 'SH']}
        walletOptions={[]}
        agentRoster={rows.map((row) => row.agentName)}
        allowEstimateMode
        estimateApiBasePath="/api/sendmoney/opening"
        estimateExtractShopName={extractSendMoneyShopName}
        estimateSkipShopNames={['OLD']}
        onImported={fetchData}
      />

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        showDateField={false}
        showLeaderField
        showOpeningBalanceField
        showSdpField
        primaryButtonClassName="bg-[color:var(--ui-accent)] hover:opacity-90"
        dataProduct="sendmoney"
      />
    </div>
  );
}
