'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Columns3, ChevronUp, ChevronDown, ChevronsUpDown, Download, BookOpen, RefreshCw,
  MoreVertical, Copy, Pencil, Eye, Trash2, Inbox, Users, Banknote, ShieldCheck, CircleSlash,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import DataTable from '../components/DataTable';
import Toolbar from '../components/Toolbar';
import ColumnsDropdown from '../components/ColumnsDropdown';
import TableFooter from '../components/TableFooter';
import EmptyState from '../components/EmptyState';
import RecordFormModal, { type RecordFormField } from '../components/RecordFormModal';
import AddRecordDropdown from '../components/AddRecordDropdown';
import BulkImportModal from '../components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '../components/BulkEditModal';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { extractRealShopName } from '../lib/realShopName';
import { isLoggedIn } from '../lib/balanceEngine';
import { getPreference, setPreference } from '../lib/preferences';
import { SETTLEMENT_BRAND_OPTIONS } from '../lib/topupOptions';
import { fmtAbbrev } from '@/app/lib/format';
import { TABLE_STICKY_HEADER_SHADOW_CLASS } from '../design-system/shadows';

// Ghost button — copied verbatim from Settlement's own toolbar button style
// (app/stlm/page.tsx), same as Top Up already adopted.
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#E2E8F0] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Row-skeleton bar widths, cycled by row+column index so loading rows read
// as varied text lengths instead of one uniform bar repeated everywhere.
const ROW_SKELETON_WIDTHS = ['85%', '60%', '75%', '50%', '70%'];

const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-indigo-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700';

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

type Row = {
  agentName: string;
  walletType: string;
  openingBal: number;
  sdp: number;
  leader: string;
  brand: string;
  _id: number;
};

// Unchanged data logic — blank/'-' coerces to 0 on this page (Cashout's own
// data model; Send Money's own Opening page keeps a genuine null instead,
// see app/sendmoney/opening/page.tsx).
function clean(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  return parseFloat(cleaned) || 0;
}

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

function fmt(num: number): string {
  if (num === 0) return '—';
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Wallet Type ("BK | NG | RK | UP") — copied verbatim from Balance
// (app/agentbal/page.tsx), same source data (SSP AG BalanceLimit via
// /api/agentbal) and same isLoggedIn-gated aggregation, per explicit
// instruction to source this from Balance.
const WALLET_TYPE_ORDER = [
  { match: 'BKASH', abbreviation: 'BK' },
  { match: 'NAGAD', abbreviation: 'NG' },
  { match: 'ROCKET', abbreviation: 'RK' },
  { match: 'UPAY', abbreviation: 'UP' },
];

function computeWalletType(types: string[]): string {
  const normalized = new Set(types.map((raw) => raw.trim().toUpperCase()).filter((t) => t && t !== '-'));

  const abbreviations = WALLET_TYPE_ORDER
    .filter(({ match }) => normalized.has(match))
    .map(({ abbreviation }) => abbreviation);

  return abbreviations.length > 0 ? abbreviations.join(' | ') : '−';
}

const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  AGENT_NAME: 'agentName',
  WALLET_TYPE: 'walletType',
  OPENING_BAL: 'openingBal',
  SDP: 'sdp',
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

// Alignment matches Settlement's own convention: text left, numbers right,
// actions center (was all-center before this port). Wallet Type stays
// between Agent Name and Opening Balance (the reorder attempt was
// reverted) and is center-aligned per explicit instruction — the
// Agent-Name-wider/Wallet-Type-narrower width change was also reverted
// (see columnWidths), centering is the actual fix instead.
const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.WALLET_TYPE, label: 'Wallet Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.OPENING_BAL, label: 'Opening Balance', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.SDP, label: 'Security Deposit', visible: true, sortable: true, hideable: true, align: 'right' },
  { key: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'openingBalanceColumnVisibility';

// Reverted back to the original split (Agent Name/Wallet Type widths
// undone) — centering Wallet Type's own content is the actual fix now,
// not a width change. Brand's own <col> reserves the 44px checkbox
// column via calc(), same trick as Settlement/Top Up's Send Money pages.
const columnWidths: Record<ColumnKey, string> = {
  brand: '14%',
  leader: '16%',
  agentName: '16%',
  walletType: '12%',
  openingBal: '16%',
  sdp: '15%',
  actions: '11%',
};

const TABLE_MIN_WIDTH_PX = 900;

function headerCellClasses(align: 'left' | 'right' | 'center', paddingCls: string = 'px-4') {
  return `group ${paddingCls} text-[14px] leading-[20px] font-semibold text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap text-${align}`;
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

// Same per-wallet tint scheme as WALLET_BADGE_TINTS elsewhere (e.g.
// app/stlm/page.tsx's own Wallet column) — Bkash pink, Nagad yellow,
// Rocket purple, Upay red — just keyed by the abbreviation
// computeWalletType() already produces (BK/NG/RK/UP) instead of the full
// wallet name, so the same real-world color association carries over.
const WALLET_TYPE_BADGE_TINTS: Record<string, string> = {
  BK: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-900/50',
  NG: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-900/50',
  RK: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  UP: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/50',
};

function walletTypeBadgeClasses(code: string): string {
  return WALLET_TYPE_BADGE_TINTS[code] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

// row.walletType is a "BK | NG | RK | UP"-style joined string (or '−' when
// no active wallet at all) — split it back into its own small pill per
// code, so a shop with several active wallets shows several badges in a
// row instead of one long plain-text string. Nowrap + horizontal scroll
// (not flex-wrap) — the column was deliberately narrowed, and wrapping
// badges onto multiple lines blew up individual row heights (53px up to
// 129px on some rows); scrolling within the cell keeps every row the same
// fixed height instead.
function WalletTypeBadge({ walletType }: { walletType: string }) {
  if (!walletType || walletType === '−') {
    return <span className="text-[#94A3B8]">−</span>;
  }
  const codes = walletType.split(' | ');
  return (
    <span className="dt-scroll inline-flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto">
      {codes.map((code) => (
        <span
          key={code}
          className={`inline-flex h-[22px] shrink-0 items-center rounded-[999px] border px-[8px] text-[11px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletTypeBadgeClasses(code)}`}
        >
          {code}
        </span>
      ))}
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

// Row actions menu (⋮) — copied from Settlement/Top Up. Edit opens the
// (UI-only, prototype) RecordFormModal; View Details/Delete stay disabled
// placeholders, matching every other module's current state.
function RowActionsCell({ row, onEdit }: { row: Row; onEdit: (row: Row) => void }) {
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
      `Brand: ${row.brand}`,
      `Leader: ${toProperCase(row.leader)}`,
      `Agent Name: ${row.agentName}`,
      `Wallet Type: ${row.walletType}`,
      `Opening Balance: ${fmt(row.openingBal)}`,
      `Security Deposit: ${fmt(row.sdp)}`,
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

function renderCell(row: Row, key: ColumnKey, onEdit: (row: Row) => void, searchTerm: string) {
  const cellCls = `whitespace-nowrap overflow-hidden text-ellipsis px-4 text-${
    DEFAULT_COLUMNS.find((c) => c.key === key)?.align ?? 'left'
  } text-[13px] leading-[20px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  const base = `${cellCls} py-[14px]`;
  switch (key) {
    case 'brand':
      return <td key={key} className={`${cellCls} py-3`}><BrandBadge brand={row.brand}>{highlightMatch(row.brand, searchTerm)}</BrandBadge></td>;
    case 'leader':
      return <td key={key} title={toProperCase(row.leader)} className={base}>{highlightMatch(toProperCase(row.leader), searchTerm)}</td>;
    case 'agentName':
      return <td key={key} title={row.agentName} className={base}>{highlightMatch(row.agentName, searchTerm)}</td>;
    case 'walletType':
      return <td key={key} title={row.walletType} className={base}><WalletTypeBadge walletType={row.walletType} /></td>;
    // Extra right padding (pr-9 instead of the shared px-4's pr-4) shifts the
    // number left so it lines up under the header word's own last letter —
    // the header's sort icon (14px + 6px gap) sits further right than the
    // text itself, and the number should follow the TEXT, not the icon.
    case 'openingBal':
      return <td key={key} className={`${base} !pr-9 !text-[12px] font-semibold tabular-nums`}>{highlightMatch(fmt(row.openingBal), searchTerm)}</td>;
    case 'sdp':
      return <td key={key} className={`${base} !pr-9 !text-[12px] font-semibold tabular-nums`}>{highlightMatch(fmt(row.sdp), searchTerm)}</td>;
    case 'actions':
      return <td key={key} className={`${cellCls} py-2.5`}><span className="flex items-center justify-center"><RowActionsCell row={row} onEdit={onEdit} /></span></td>;
    default:
      return null;
  }
}

export default function Summary() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('leader');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);

  const [editingRow, setEditingRow] = useState<Row | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);

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
      setRows([]);
      const [res, balRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
      ]);
      await assertAllOk([res, balRes]);
      const text = await res.text();
      const balText = await balRes.text();

      const brandGroups = new Map<string, string[]>();
      // Wallet Type values, isLoggedIn-gated — same aggregation as Balance's
      // own walletTypeValues (app/agentbal/page.tsx), cols 4 (Wallet Type)
      // and 15 (Login) off the same "SSP AG BalanceLimit" data.
      const walletTypeValues = new Map<string, string[]>();
      balText
        .trim()
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '')
        .forEach((line) => {
          const cols = line.split(',');
          const walletName = cols[1]?.replace(/"/g, '').trim();
          const group = cols[6]?.replace(/"/g, '').trim();
          const walletType = cols[4]?.replace(/"/g, '').trim();
          const login = cols[15]?.replace(/"/g, '').trim() ?? '';
          if (!walletName || walletName === '-') return;
          const groups = brandGroups.get(walletName) ?? [];
          groups.push(group);
          brandGroups.set(walletName, groups);

          if (walletType && walletType !== '-' && isLoggedIn(login)) {
            const types = walletTypeValues.get(walletName) ?? [];
            types.push(walletType);
            walletTypeValues.set(walletName, types);
          }
        });

      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line, index) => {
          const cols = line.split(',');
          const agentName = cols[0]?.replace(/"/g, '').trim();
          return {
            agentName,
            walletType: computeWalletType(walletTypeValues.get(agentName) ?? []),
            openingBal: clean(cols[1]),
            sdp: clean(cols[2]),
            leader: cols[3]?.replace(/"/g, '').trim(),
            brand: resolveBrand(brandGroups.get(agentName) ?? [], agentName),
            _id: index,
          };
        })
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');
      setRows(parsed);
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

  const filteredRows = rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${row.walletType} ${fmt(row.openingBal)} ${fmt(row.sdp)} ${row.brand}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: Row) => {
        switch (sortColumn) {
          case 'brand':
            return row.brand.toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'agentName':
            return row.agentName.toLowerCase();
          case 'walletType':
            return row.walletType.toLowerCase();
          case 'openingBal':
            return row.openingBal;
          case 'sdp':
            return row.sdp;
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

  const handleBulkEditApply = useCallback((updates: BulkEditUpdates) => {
    setRows((current) => current.map((row) => {
      if (!selectedIds.has(row._id)) return row;
      return {
        ...row,
        ...(updates.leader !== undefined ? { leader: updates.leader } : {}),
        ...(updates.openingBalance !== undefined ? { openingBal: clean(updates.openingBalance) } : {}),
        ...(updates.sdp !== undefined ? { sdp: clean(updates.sdp) } : {}),
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

  const openingRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: SETTLEMENT_BRAND_OPTIONS, required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'text', required: true },
    { key: 'leader', label: 'Leader', kind: 'text' },
    { key: 'openingBalance', label: 'Opening Balance', kind: 'amount' },
    { key: 'sdp', label: 'SDP', kind: 'amount' },
  ], []);

  const handleExport = useCallback(() => {
    const getExportValue = (row: Row, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand;
        case 'leader':
          return row.leader;
        case 'agentName':
          return row.agentName;
        case 'walletType':
          return row.walletType;
        case 'openingBal':
          return fmt(row.openingBal);
        case 'sdp':
          return fmt(row.sdp);
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
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Opening Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_OPENING_BALANCE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Balance-style KPI cards (bespoke, not SettlementSummary — that component
  // is shared with the Send Money Opening equivalent, which wasn't part of
  // this redesign). Count metrics have no subtitle (would just duplicate the
  // big value); amount metrics get an abbreviated big value + full-figure
  // subtitle (this page's own `fmt`, above), matching Balance's Total DP/
  // Total WD pattern exactly.
  const kpis = useMemo(() => {
    const totalOpening = rows.reduce((sum, row) => sum + row.openingBal, 0);
    const totalSdp = rows.reduce((sum, row) => sum + row.sdp, 0);
    return [
      {
        label: 'Total Accounts', icon: Users,
        accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-50 dark:bg-indigo-500/10',
        bigValue: rows.length.toLocaleString('en-US'), subtitle: undefined as string | undefined,
      },
      {
        label: 'Total Opening Balance', icon: Banknote,
        accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-50 dark:bg-emerald-500/10',
        bigValue: fmtAbbrev(totalOpening), subtitle: fmt(totalOpening) as string | undefined,
      },
      {
        label: 'Total SDP', icon: ShieldCheck,
        accent: 'text-blue-600 dark:text-blue-400', iconBg: 'bg-blue-50 dark:bg-blue-500/10',
        bigValue: fmtAbbrev(totalSdp), subtitle: fmt(totalSdp) as string | undefined,
      },
      {
        label: 'No Opening Yet', icon: CircleSlash,
        accent: 'text-rose-600 dark:text-rose-400', iconBg: 'bg-rose-50 dark:bg-rose-500/10',
        bigValue: rows.filter((row) => row.openingBal === 0).length.toLocaleString('en-US'), subtitle: undefined as string | undefined,
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
    <div
      className="h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]"
      style={{ fontFamily: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif' }}
    >
      <SettlementHeader
        icon={BookOpen}
        title="Opening"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />
      <div className={`w-full border-t border-border bg-[#f4f6fb] px-4 py-3 transition-shadow duration-150 ease-out dark:bg-[#1c1c1e] md:px-6 ${isScrolled ? TABLE_STICKY_HEADER_SHADOW_CLASS : ''}`}>
        <div className="flex gap-2 pr-2">
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
            <Toolbar>
              <Toolbar.Left>
                <div className="flex h-10 w-full min-w-[200px] items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-[14px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] sm:w-[380px]">
                  {loading ? (
                    <div className="dt-skeleton h-3 w-32 rounded-md" />
                  ) : (
                    <>
                      <Search size={16} className="shrink-0 text-[#94A3B8]" />
                      <input
                        aria-label="Search shops or brands"
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[13px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
                        placeholder="Search shops or brands..."
                      />
                    </>
                  )}
                </div>
              </Toolbar.Left>
              <Toolbar.Right>
                {loading && (
                  <>
                    <div className="dt-skeleton h-9 w-[76px] rounded-[8px]" />
                    <div className="dt-skeleton h-8 w-8 rounded-[8px]" />
                    <div className="dt-skeleton h-9 w-[88px] rounded-[8px]" />
                    <div className="dt-skeleton h-9 w-[104px] rounded-[8px]" />
                  </>
                )}
                {!loading && (
                  <>
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
                        templateModule="openingCashout"
                        onNewRecord={() => setNewRecordOpen(true)}
                        onBulkImport={() => setBulkImportOpen(true)}
                        buttonClassName="bg-indigo-600 hover:bg-indigo-700"
                      />
                    )}
                    <button type="button" onClick={fetchData} aria-label="Refresh" title="Refresh" className={GHOST_BUTTON}>
                      <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
                    </button>
                    <button type="button" onClick={handleExport} aria-label="Export to Excel" title="Export to Excel" className={GHOST_BUTTON}>
                      <Download size={15} />
                      Export
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        ref={columnsButtonRef}
                        onClick={() => setColumnsMenuOpen((current) => !current)}
                        aria-haspopup="true"
                        aria-expanded={columnsMenuOpen}
                        aria-controls="opening-columns-popover"
                        aria-label="Columns"
                        title="Columns"
                        className={GHOST_BUTTON}
                      >
                        <Columns3 size={15} />
                        Columns
                      </button>
                      <ColumnsDropdown
                        id="opening-columns-popover"
                        open={columnsMenuOpen}
                        onOpenChange={setColumnsMenuOpen}
                        anchorRef={columnsButtonRef}
                        columns={columnDefs}
                        onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))}
                        onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                      />
                    </div>
                  </>
                )}
              </Toolbar.Right>
            </Toolbar>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
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
                            className={`relative flex w-full items-center gap-1.5 text-${col.align} transition-[opacity,transform] duration-150 ease-[var(--ease-out-strong)] hover:opacity-80 active:scale-[0.98] ${
                              col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : 'justify-start'
                            }`}
                          >
                            <span>{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
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
                      {visibleColumns.map((col, colIdx) => (
                        <td key={col.key} className="px-4 py-[14px]">
                          <div
                            className="dt-skeleton h-3 rounded-md"
                            style={{ width: ROW_SKELETON_WIDTHS[(i + colIdx) % ROW_SKELETON_WIDTHS.length] }}
                          />
                        </td>
                      ))}
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
                    <div key={row.agentName || i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName}</p>
                          <p className="truncate text-[12px] font-normal text-muted-foreground">{toProperCase(row.leader)}{row.brand !== '−' ? ` · ${row.brand}` : ''}{row.walletType !== '−' ? ` · ${row.walletType}` : ''}</p>
                        </div>
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground">Opening Balance</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.openingBal)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground">Security Deposit</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.sdp)}</p>
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
              <TableFooter
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
      </main>

      <RecordFormModal
        isOpen={editingRow !== null}
        onClose={() => setEditingRow(null)}
        title="Edit Account"
        fields={openingRecordFields}
        initialValues={editingRow ? {
          brand: editingRow.brand,
          agentName: editingRow.agentName,
          leader: editingRow.leader,
          openingBalance: editingRow.openingBal ? String(editingRow.openingBal) : '',
          sdp: editingRow.sdp ? String(editingRow.sdp) : '',
        } : {}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        title="New Account"
        fields={openingRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        moduleLabel="Opening Balance Accounts"
        templateModule="openingCashout"
        moduleKind="opening"
        accentButtonClassName="bg-indigo-600 hover:bg-indigo-700"
        brandOptions={SETTLEMENT_BRAND_OPTIONS}
        walletOptions={[]}
        agentRoster={rows.map((row) => row.agentName)}
        allowEstimateMode
        estimateApiBasePath="/api/opening"
        estimateExtractShopName={extractRealShopName}
        estimateSkipShopNames={['OLD', 'MANUAL']}
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
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />
    </div>
  );
}
