'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Columns3, Download, RefreshCw, Search, Flag, Check, X, SquarePen, Loader2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '@/app/components/SettlementHeader';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import DataTable from '@/app/components/DataTable';
import Toolbar from '@/app/components/Toolbar';
import ColumnsDropdown from '@/app/components/ColumnsDropdown';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '@/app/lib/csv';
import { getBusinessToday } from '@/app/lib/businessDate';
import { getPreference, setPreference } from '@/app/lib/preferences';
import { computeCompanyBalance, resolveBrand } from '@/app/lib/balanceEngine';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';

// Mirrors app/lib/walletStatus.ts's own types — not imported directly since
// that file pulls in `googleapis` (Node-only, breaks the client bundle);
// every other page that reads a write-capable lib (e.g. Estimated Opening)
// follows this same "fetch via API route, define a matching local type"
// convention instead of importing the server-only module.
type DepositWithdrawal = 'Yes' | 'No';
type Priority = 'Low' | 'Normal' | 'High';
// '' = never set — a real, displayable state ("−"), not a default to fall
// back through like Deposit/Withdrawal/Priority above.
type WalletStatusValue = 'Active' | 'Inactive' | 'Suspended' | '';
type WalletStatusEntry = { deposit: DepositWithdrawal; withdrawal: DepositWithdrawal; priority: Priority; walletStatus: WalletStatusValue };
const DEFAULT_WALLET_STATUS_ENTRY: WalletStatusEntry = { deposit: 'No', withdrawal: 'No', priority: 'Normal', walletStatus: '' };

// Inline-edit spec: click-to-edit, single row at a time, colored dots only.
const WALLET_STATUS_OPTIONS: { value: Exclude<WalletStatusValue, ''>; label: string; dot: string }[] = [
  { value: 'Active', label: 'Active', dot: 'bg-emerald-500' },
  { value: 'Inactive', label: 'Inactive', dot: 'bg-amber-400' },
  { value: 'Suspended', label: 'Suspended', dot: 'bg-rose-500' },
];
const WALLET_STATUS_DOT: Record<Exclude<WalletStatusValue, ''>, string> = {
  Active: 'bg-emerald-500',
  Inactive: 'bg-amber-400',
  Suspended: 'bg-rose-500',
};

// Format mimics Transfer Queue (app/sendmoney/transfer-queue/page.tsx) per
// explicit instruction — same GHOST_BUTTON toolbar, SettlementHeader,
// DataTable, native table w/ colgroup, ColumnsDropdown, TableFooter, mobile
// card list. Cashout counterpart: app/wallet-status/page.tsx.
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-colors duration-150 ease-out hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

const TABLE_MIN_WIDTH_PX = 1200;
const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

function displayNum(num: number): string {
  if (Math.abs(num) < 0.01) return '−';
  const formatted = Math.abs(num).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// Send Money's own agent keys aren't always cased/spaced the same between
// "Opening AG" and "PS BD STLM + TOPUP" — normalized before every map
// lookup, same fix as app/sendmoney/balances/page.tsx.
function normalizeAgentKey(name: string): string {
  return name.toUpperCase().replace(/\s+/g, '');
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
const BRAND_CODES = [...CASHOUT_BRAND_CODES, 'SH'];

const PRIORITY_OPTIONS: Priority[] = ['Low', 'Normal', 'High'];
const PRIORITY_RANK: Record<Priority, number> = { Low: 0, Normal: 1, High: 2 };
const YES_NO_OPTIONS: DepositWithdrawal[] = ['Yes', 'No'];

type WalletStatusRow = {
  key: string;
  shopName: string;
  brand: string;
  companyBalance: number;
  sdpDisplay: string;
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  priority: Priority;
  walletStatus: WalletStatusValue;
};

const COLUMN_IDS = {
  BRAND: 'brand',
  SHOP_NAME: 'shopName',
  COMPANY_BALANCE: 'companyBalance',
  SDP: 'sdp',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  PRIORITY: 'priority',
  WALLET_STATUS: 'walletStatus',
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
  { key: COLUMN_IDS.SHOP_NAME, label: 'Shop Name', visible: true, sortable: true, hideable: true, align: 'left' },
  { key: COLUMN_IDS.COMPANY_BALANCE, label: 'Company Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SDP, label: 'SDP', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DEPOSIT, label: 'Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WITHDRAWAL, label: 'Withdrawal', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.PRIORITY, label: 'Priority', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WALLET_STATUS, label: 'Wallet Status', visible: true, sortable: true, hideable: false, align: 'center' },
  // Single Edit/Save/Cancel per ROW, covering all four editable fields
  // (Deposit/Withdrawal/Priority/Wallet Status) together — per explicit
  // instruction, dropdowns stay read-only until this row's Edit icon is
  // clicked, and one Save/Cancel commits or discards all of them at once.
  // Never hideable — it's the only edit affordance for the row.
  { key: COLUMN_IDS.WALLET_STATUS_ACTION, label: '', visible: true, sortable: false, hideable: false, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyWalletStatusColumnVisibility';

// Wallet Status / its Action column are fixed px per spec ("Never resize.
// Never shift. Never wrap.") — every other column stays percentage-based;
// table-fixed + the horizontal-scroll fallback absorb the mixed units fine.
const columnWidths: Record<ColumnKey, string> = {
  brand: '8%',
  shopName: '22%',
  companyBalance: '13%',
  sdp: '11%',
  deposit: '9%',
  withdrawal: '9%',
  priority: '8%',
  walletStatus: '170px',
  walletStatusAction: '72px',
};

const rowSkeletonWidths: Record<ColumnKey, string[]> = {
  brand: ['w-8', 'w-10', 'w-9'],
  shopName: ['w-24', 'w-28', 'w-20'],
  companyBalance: ['w-16', 'w-20', 'w-14'],
  sdp: ['w-14', 'w-16', 'w-12'],
  deposit: ['w-10', 'w-10', 'w-10'],
  withdrawal: ['w-10', 'w-10', 'w-10'],
  priority: ['w-14', 'w-14', 'w-14'],
  walletStatus: ['w-20', 'w-24', 'w-16'],
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
  SH: 'bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-500/10 dark:text-lime-400 dark:border-lime-900/50',
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

const PRIORITY_BADGE_TINTS: Record<Priority, string> = {
  High: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-900/50',
  Normal: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700',
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/50',
};

// Native <select> kept intentionally plain (no custom dropdown/portal) —
// this is a live, persisted edit per cell, not a filter; a plain select is
// the simplest control that can't be mistaken for a filter trigger.
//
// Read-only (disabled) until the row's own Edit icon is clicked — per
// explicit instruction, dropdowns for Deposit/Withdrawal/Priority/Wallet
// Status only become interactive in edit mode, same as Wallet Status
// already worked; changing any of them only stages a draft, never saves
// directly. One Save/Cancel pair (the row's Action column) commits or
// discards every changed field together.
function StatusSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: T[];
  onChange: (next: T) => void;
  disabled: boolean;
  className: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={`h-7 rounded-md border px-1.5 text-[12px] font-medium outline-none transition-opacity disabled:opacity-60 ${className}`}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

const EDITABLE_FIELDS = ['deposit', 'withdrawal', 'priority', 'walletStatus'] as const;
type EditableField = typeof EDITABLE_FIELDS[number];
type RowDraft = { deposit: DepositWithdrawal; withdrawal: DepositWithdrawal; priority: Priority; walletStatus: WalletStatusValue };

function rowHasChanges(row: WalletStatusRow, draft: RowDraft | null): boolean {
  if (!draft) return false;
  return EDITABLE_FIELDS.some((field) => draft[field] !== row[field]);
}

export default function SendMoneyWalletStatus() {
  const [rows, setRows] = useState<WalletStatusRow[]>([]);
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
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // One row editable at a time, covering all four fields together
  // (Deposit/Withdrawal/Priority/Wallet Status) — per explicit instruction,
  // there's a single Edit icon per row, not one staging mechanism per
  // dropdown. editingRowKey being a single value (not a Set/per-field map)
  // is what makes "starting to edit another row auto-cancels the previous
  // one" free — the old row's cells stop matching and revert to showing
  // their saved values with no extra cleanup needed.
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
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/sendmoney/wallet-status?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, statusRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();
      const statusData: Record<string, WalletStatusEntry> = await statusRes.json();

      const reportCutoffDate = getBusinessToday();

      // Send Money's own roster lives in cols L-O (indices 11-14) of the
      // same "Opening AG" sheet Cashout uses for cols A-D.
      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[11]),
          openingBal: rawVal(row[12]),
          sdp: rawVal(row[13]),
          leader: rawVal(row[14]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      // "SSP PS BalanceLimit" lines up column-for-column with Cashout's own
      // sheet from index 4 onward — no leading "Reference" column.
      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[0]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          group: rawVal(row[6]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const brandGroups = new Map<string, string[]>();
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
      });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = normalizeAgentKey(rawVal(row[1]));
          const topUpAmount = rawVal(row[2]);
          const topUpDate = parseSheetDate(rawVal(row[3]));
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' && topUpDate && topUpDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }
          const stlmAgent = normalizeAgentKey(rawVal(row[7]));
          const stlmAmount = rawVal(row[8]);
          const stlmDate = parseSheetDate(rawVal(row[9]));
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' && stlmDate && stlmDate >= reportCutoffDate) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: WalletStatusRow[] = openingRows.map((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(normalizeAgentKey(opening.agentName)) ?? 0;
        const totalStlm = stlmTotals.get(normalizeAgentKey(opening.agentName)) ?? 0;
        const companyBalance = computeCompanyBalance(parseNumber(opening.openingBal), totals.dp, totalTopUp, totals.wd, totalStlm);
        const sdpTrimmed = opening.sdp.trim().toUpperCase();
        const sdpDisplay = sdpTrimmed === 'NO SDP' || !opening.sdp || opening.sdp === '-' ? '−' : displayNum(parseNumber(opening.sdp));
        const status = statusData[opening.agentName.toUpperCase()] ?? DEFAULT_WALLET_STATUS_ENTRY;
        return {
          key: opening.agentName,
          shopName: opening.agentName,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName, { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES, validateComputedBrand: true }),
          companyBalance,
          sdpDisplay,
          deposit: status.deposit,
          withdrawal: status.withdrawal,
          priority: status.priority,
          walletStatus: status.walletStatus,
        };
      });

      setRows(merged);
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

  // Click Edit -> stage a full-row draft (all 4 fields, seeded from the
  // row's current saved values) and enter edit mode. Nothing saves until
  // Save is clicked; Cancel just discards the draft. editingRowKey being a
  // single value means starting to edit a different row automatically
  // ends the previous edit — its cells just stop matching and fall back to
  // showing their saved values.
  const startEdit = useCallback((row: WalletStatusRow) => {
    setEditingRowKey(row.key);
    setEditDraft({ deposit: row.deposit, withdrawal: row.withdrawal, priority: row.priority, walletStatus: row.walletStatus });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingRowKey(null);
    setEditDraft(null);
  }, []);

  const updateDraftField = useCallback((field: EditableField, value: string) => {
    setEditDraft((current) => (current ? { ...current, [field]: value } : current));
  }, []);

  // The single point where a row's staged edits actually persist — one
  // Save click saves every changed field in that row (1-4 requests, fired
  // together), to the "Wallet Status" sheet tab (see
  // app/lib/walletStatus.ts). On a partial/total failure, refetches from
  // the server instead of guessing which individual writes landed, so the
  // UI can't end up claiming a save succeeded when only some fields did.
  const saveRow = useCallback((row: WalletStatusRow) => {
    if (!editDraft || !rowHasChanges(row, editDraft)) return;
    const draft = editDraft;
    const fields = EDITABLE_FIELDS.filter((field) => draft[field] !== row[field]);

    setRowSaving(true);
    setSaveError(null);

    Promise.all(
      fields.map((field) =>
        fetch('/api/sendmoney/wallet-status/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopName: row.shopName, field, value: draft[field] }),
        }).then((res) => {
          if (!res.ok) throw new Error(`Save failed for ${field}`);
          return field;
        })
      )
    )
      .then((savedFields) => {
        setRows((current) => current.map((r) => (
          r.key === row.key
            ? { ...r, ...Object.fromEntries(savedFields.map((f) => [f, draft[f]])) }
            : r
        )));
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
    return rows.filter((row) => `${row.shopName} ${row.brand}`.toLowerCase().includes(query));
  }, [rows, searchTerm]);

  const sortedRows = useMemo(() => {
    const list = [...searchedRows];
    list.sort((a, b) => {
      const getValue = (row: WalletStatusRow, column: ColumnKey) => {
        switch (column) {
          case 'brand': return row.brand.toLowerCase();
          case 'shopName': return row.shopName.toLowerCase();
          case 'companyBalance': return row.companyBalance;
          case 'sdp': return row.sdpDisplay === '−' ? -Infinity : parseNumber(row.sdpDisplay);
          case 'deposit': return row.deposit;
          case 'withdrawal': return row.withdrawal;
          case 'priority': return PRIORITY_RANK[row.priority];
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
  }, [searchedRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, startIndex + rowsPerPage);

  const visibleColumns = useMemo(() => (mounted ? columnDefs : []).filter((col) => col.visible), [columnDefs, mounted]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: WalletStatusRow, key: ColumnKey) => {
      switch (key) {
        case 'brand': return row.brand;
        case 'shopName': return row.shopName;
        case 'companyBalance': return row.companyBalance;
        case 'sdp': return row.sdpDisplay;
        case 'deposit': return row.deposit;
        case 'withdrawal': return row.withdrawal;
        case 'priority': return row.priority;
        case 'walletStatus': return row.walletStatus;
      }
    };
    // The Edit/Save/Cancel action column has no exportable value — excluded
    // from the sheet rather than producing an empty, unlabeled column.
    const exportColumns = visibleColumns.filter((col) => col.key !== 'walletStatusAction');
    const headers = exportColumns.map((col) => col.label);
    const data = sortedRows.map((row) => exportColumns.map((col) => getExportValue(row, col.key)));
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Wallet Status');
    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_WALLET_STATUS_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  // Success toast — top right, 2s, per spec.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  function renderCell(row: WalletStatusRow, key: ColumnKey) {
    const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-center px-4 py-[14px] align-top';
    const shopBase = 'whitespace-nowrap overflow-hidden text-ellipsis text-[13px] font-normal text-left px-4 py-[14px] align-top';
    const isEditingThisRow = editingRowKey === row.key;
    switch (key) {
      case 'brand':
        return <td key={key} className={base}><BrandBadge>{row.brand}</BrandBadge></td>;
      case 'shopName':
        return <td key={key} className={`${shopBase} text-foreground`}>{row.shopName}</td>;
      case 'companyBalance':
        return (
          <td key={key} className={`${base} tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
            {displayNum(row.companyBalance)}
          </td>
        );
      case 'sdp':
        return <td key={key} className={`${base} tabular-nums text-foreground`}>{row.sdpDisplay}</td>;
      case 'deposit': {
        const value = isEditingThisRow && editDraft ? editDraft.deposit : row.deposit;
        return (
          <td key={key} className={base}>
            <StatusSelect
              value={value}
              options={YES_NO_OPTIONS}
              disabled={!isEditingThisRow || rowSaving}
              onChange={(next) => updateDraftField('deposit', next)}
              className={value === 'Yes'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}
            />
          </td>
        );
      }
      case 'withdrawal': {
        const value = isEditingThisRow && editDraft ? editDraft.withdrawal : row.withdrawal;
        return (
          <td key={key} className={base}>
            <StatusSelect
              value={value}
              options={YES_NO_OPTIONS}
              disabled={!isEditingThisRow || rowSaving}
              onChange={(next) => updateDraftField('withdrawal', next)}
              className={value === 'Yes'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}
            />
          </td>
        );
      }
      case 'priority': {
        const value = isEditingThisRow && editDraft ? editDraft.priority : row.priority;
        return (
          <td key={key} className={base}>
            <StatusSelect
              value={value}
              options={PRIORITY_OPTIONS}
              disabled={!isEditingThisRow || rowSaving}
              onChange={(next) => updateDraftField('priority', next)}
              className={PRIORITY_BADGE_TINTS[value]}
            />
          </td>
        );
      }
      case 'walletStatus': {
        const displayValue = (isEditingThisRow && editDraft ? editDraft.walletStatus : row.walletStatus) ?? '';
        // A never-set row shows "−" at rest, but Edit must still open the
        // dropdown (spec: "After Edit → Dropdown automatically opens") — the
        // "−" short-circuit only applies while NOT editing.
        if (!displayValue && !isEditingThisRow) {
          return <td key={key} className={base}><span className="text-muted-foreground">−</span></td>;
        }
        return (
          <td key={key} className={base}>
            <span className="inline-flex items-center gap-1.5">
              {displayValue && <span className={`h-2 w-2 shrink-0 rounded-full ${WALLET_STATUS_DOT[displayValue as Exclude<WalletStatusValue, ''>]}`} />}
              <select
                value={displayValue}
                disabled={!isEditingThisRow || rowSaving}
                onChange={(event) => updateDraftField('walletStatus', event.target.value)}
                className={`h-7 rounded-md border bg-white px-1.5 text-[12px] font-medium outline-none transition-[background-color,border-color,opacity] duration-150 ease-out disabled:cursor-default disabled:opacity-100 dark:bg-[#2a2a2d] ${
                  isEditingThisRow ? 'border-[#5B5CEB]' : 'border-transparent'
                }`}
              >
                {!displayValue && <option value="">Select…</option>}
                {WALLET_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </span>
          </td>
        );
      }
      case 'walletStatusAction': {
        if (!isEditingThisRow) {
          return (
            <td key={key} className={base}>
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
          <td key={key} className={base}>
            <span className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => saveRow(row)}
                disabled={!canSave || rowSaving}
                aria-label="Save Changes"
                title="Save Changes"
                className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#5B5CEB] text-white transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
              >
                {rowSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={rowSaving}
                aria-label="Cancel"
                title="Cancel"
                className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#E5E7EB] bg-white text-slate-500 transition-colors duration-150 ease-out hover:bg-[#F8FAFC] disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
              >
                <X size={16} />
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
            <Toolbar>
              <Toolbar.Left>
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
                      onClick={() => setColumnsMenuOpen((current) => !current)}
                      aria-haspopup="true"
                      aria-expanded={columnsMenuOpen}
                      aria-controls="sendmoney-wallet-status-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className={GHOST_BUTTON}
                    >
                      <Columns3 size={15} />
                      Columns
                    </button>
                    <ColumnsDropdown
                      id="sendmoney-wallet-status-columns-popover"
                      open={columnsMenuOpen}
                      onOpenChange={setColumnsMenuOpen}
                      anchorRef={columnsButtonRef}
                      columns={columnDefs}
                      onToggle={(key) => setColumnDefs((current) => current.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))}
                      onRestoreDefaults={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                    />
                  </div>
                )}
              </Toolbar.Right>
            </Toolbar>
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <div className="relative hidden flex-1 min-h-0 sm:block">
              <div ref={tableScrollRef} className="dt-scroll h-full overflow-y-auto overflow-x-auto">
                <table className="w-full table-fixed text-xs" style={{ minWidth: TABLE_MIN_WIDTH_PX }}>
                  <colgroup>
                    {visibleColumns.map((col) => (
                      <col key={col.key} style={{ width: columnWidths[col.key] }} />
                    ))}
                  </colgroup>
                  <thead className={`sticky top-0 z-[50] bg-[#FAFAFB] dark:bg-[#252528] border-b border-[#E2E8F0] dark:border-[#3a3a3d] transition-shadow duration-150 ease-out ${isScrolled ? 'shadow-[0_2px_4px_rgba(15,23,42,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]' : ''}`}>
                    <tr className="h-[48px]">
                      {visibleColumns.map((col) => (
                        <th key={col.key} className={headerCellClasses(col.align)}>
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
                                <span aria-hidden="true" className="invisible">
                                  <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                                </span>
                              )}
                              <span className={`min-w-0 truncate ${col.align === 'center' ? 'flex-1' : ''}`}>{col.label}</span>
                              <SortIcon active={sortColumn === col.key} direction={sortDirection} />
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
                          {visibleColumns.map((col) => {
                            const widths = rowSkeletonWidths[col.key];
                            const width = widths[rowIndex % widths.length];
                            return (
                              <td key={col.key} className="px-4 py-[14px]">
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
                            : `border-border ${i % 2 === 1 ? 'bg-muted/5' : ''}`
                        }`}
                      >
                        {visibleColumns.map((col) => renderCell(row, col.key))}
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={Math.max(visibleColumns.length, 1)}>
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
                    const showBalance = visibleColumns.some((c) => c.key === 'companyBalance');
                    const showSdp = visibleColumns.some((c) => c.key === 'sdp');
                    const showDeposit = visibleColumns.some((c) => c.key === 'deposit');
                    const showWithdrawal = visibleColumns.some((c) => c.key === 'withdrawal');
                    const showPriority = visibleColumns.some((c) => c.key === 'priority');
                    const showWalletStatus = visibleColumns.some((c) => c.key === 'walletStatus');
                    const isEditingThisRow = editingRowKey === row.key;
                    const depositValue = isEditingThisRow && editDraft ? editDraft.deposit : row.deposit;
                    const withdrawalValue = isEditingThisRow && editDraft ? editDraft.withdrawal : row.withdrawal;
                    const priorityValue = isEditingThisRow && editDraft ? editDraft.priority : row.priority;
                    const walletStatusDisplayValue = (isEditingThisRow && editDraft ? editDraft.walletStatus : row.walletStatus) ?? '';
                    const canSave = rowHasChanges(row, editDraft);
                    return (
                      <div
                        key={row.key}
                        className={`rounded-xl border p-3.5 transition-[background-color,border-color] duration-150 ease-out dark:bg-[#2a2a2d] ${
                          isEditingThisRow ? 'border-[#5B5CEB] bg-[#F8F9FF] dark:bg-[#5B5CEB]/[0.08]' : 'border-border bg-white'
                        }`}
                      >
                        {(showShop || showBrand) && (
                          <div className="flex items-start justify-between gap-2">
                            {showShop && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.shopName}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{row.brand}</span>}
                          </div>
                        )}
                        {(showBalance || showSdp) && (
                          <div className={`grid grid-cols-2 gap-2 ${(showShop || showBrand) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showBalance && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Company Balance</p>
                                <p className={`text-[13px] font-bold tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{displayNum(row.companyBalance)}</p>
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
                        {(showDeposit || showWithdrawal || showPriority) && (
                          <div className={`flex flex-wrap items-center gap-2 ${(showShop || showBrand || showBalance || showSdp) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showDeposit && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Deposit</p>
                                <StatusSelect
                                  value={depositValue}
                                  options={YES_NO_OPTIONS}
                                  disabled={!isEditingThisRow || rowSaving}
                                  onChange={(next) => updateDraftField('deposit', next)}
                                  className={depositValue === 'Yes'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}
                                />
                              </div>
                            )}
                            {showWithdrawal && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Withdrawal</p>
                                <StatusSelect
                                  value={withdrawalValue}
                                  options={YES_NO_OPTIONS}
                                  disabled={!isEditingThisRow || rowSaving}
                                  onChange={(next) => updateDraftField('withdrawal', next)}
                                  className={withdrawalValue === 'Yes'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400'
                                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-400'}
                                />
                              </div>
                            )}
                            {showPriority && (
                              <div>
                                <p className="mb-1 text-[9px] font-medium text-muted-foreground">Priority</p>
                                <StatusSelect
                                  value={priorityValue}
                                  options={PRIORITY_OPTIONS}
                                  disabled={!isEditingThisRow || rowSaving}
                                  onChange={(next) => updateDraftField('priority', next)}
                                  className={PRIORITY_BADGE_TINTS[priorityValue]}
                                />
                              </div>
                            )}
                          </div>
                        )}
                        {showWalletStatus && (
                          <div className={`flex items-center gap-1.5 ${(showShop || showBrand || showBalance || showSdp || showDeposit || showWithdrawal || showPriority) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            <p className="text-[9px] font-medium text-muted-foreground">Wallet Status</p>
                            {(walletStatusDisplayValue || isEditingThisRow) ? (
                              <span className="inline-flex items-center gap-1.5">
                                {walletStatusDisplayValue && <span className={`h-2 w-2 shrink-0 rounded-full ${WALLET_STATUS_DOT[walletStatusDisplayValue as Exclude<WalletStatusValue, ''>]}`} />}
                                <select
                                  value={walletStatusDisplayValue}
                                  disabled={!isEditingThisRow || rowSaving}
                                  onChange={(event) => updateDraftField('walletStatus', event.target.value)}
                                  className={`h-7 rounded-md border bg-white px-1.5 text-[12px] font-medium outline-none transition-[background-color,border-color,opacity] duration-150 ease-out disabled:cursor-default disabled:opacity-100 dark:bg-[#2a2a2d] ${
                                    isEditingThisRow ? 'border-[#5B5CEB]' : 'border-transparent'
                                  }`}
                                >
                                  {!walletStatusDisplayValue && <option value="">Select…</option>}
                                  {WALLET_STATUS_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </span>
                            ) : (
                              <span className="text-[12px] text-muted-foreground">−</span>
                            )}
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
                                className="flex h-8 flex-1 items-center justify-center gap-1 rounded-[10px] border border-[#E5E7EB] bg-white text-[12px] font-semibold text-slate-500 transition-colors duration-150 ease-out disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
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
    </div>
  );
}
