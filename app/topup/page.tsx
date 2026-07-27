'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronUp, ChevronDown, Columns3, Download, PlusCircle, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import PageHeader from '../components/PageHeader';
import ProductSwitchTabs from '../components/ProductSwitchTabs';
import ThemeToggle from '../components/ThemeToggle';
import Toolbar from '../components/Toolbar';
import DataTable from '../components/DataTable';
import TableFooter from '../components/TableFooter';
import EmptyState from '../components/EmptyState';
import ConnectionErrorState from '../components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError } from '../lib/errors';
import { rawVal, fmtNum, parseAmount } from '@/app/lib/format';
import { isToday } from '../lib/businessDate';
import { TABLE_STICKY_HEADER_CLASS, TABLE_HEADER_CELL_CLASS, TOOLBAR_ROW_CLASS, TOOLBAR_LEFT_CLASS, TOOLBAR_RIGHT_CLASS } from '../design-system/table';
import { PAGE_MAIN_PADDING_CLASS } from '../design-system/spacing';
import { getPreference, setPreference } from '../lib/preferences';

// "AG BD STLM + TOPUP" no longer carries a brand/gateway column (removed from
// the sheet). Brand now comes first from the "-<brand>" suffix already
// displayed on the shop/agent name itself (e.g. "KONAN001-M1" → M1) when
// present; only when a row's shop name has no suffix (e.g. "YUJI024") does
// it fall back to cross-referencing the bare agent code against "SSP AG
// BalanceLimit" (same Group data and priority logic Cashout's own Agent
// Balance page already uses).
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

// "To Agent" values on the new sheet sometimes carry a trailing "-<brand>"
// suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") — strip it so
// the bare code matches "SSP AG BalanceLimit"'s own (always-bare) wallet names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
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

type TopUpRow = {
  agentName: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
  leader: string;
  brand: string;
};


// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's.
const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  AGENT_NAME: 'agentName',
  WALLET: 'wallet',
  AMOUNT: 'amount',
  TYPE: 'type',
  DATE: 'date',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];
type SortColumn = '' | Exclude<ColumnKey, typeof COLUMN_IDS.BRAND | typeof COLUMN_IDS.LEADER>;

// Column model matches Settlement's ColumnDef shape (`key` kept instead of
// Settlement's `id` since every existing reference on this page already
// reads `col.key`). No protected Actions-style column exists here, so all
// columns are hideable.
type ColumnDef = {
  key: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: false, hideable: true, align: 'center' },
  { key: COLUMN_IDS.LEADER, label: 'Leader', visible: true, sortable: false, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.TYPE, label: 'Type', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'topUpColumnVisibility';

const columns: { key: ColumnKey; label: string }[] = DEFAULT_COLUMNS.map((col) => ({ key: col.key, label: col.label }));

const columnWidths: Record<ColumnKey, string> = {
  brand: '10%',
  leader: '12%',
  agentName: '18%',
  wallet: '13%',
  amount: '14%',
  type: '13%',
  date: '20%',
};

function headerCellClasses(_active: boolean) {
  return `group ${TABLE_HEADER_CELL_CLASS}`;
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-0 transition-opacity duration-150 group-hover:opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={10} className="text-indigo-600 dark:text-indigo-400" />
  ) : (
    <ChevronDown size={10} className="text-indigo-600 dark:text-indigo-400" />
  );
}

function renderCell(row: TopUpRow, key: ColumnKey) {
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis px-3 py-1.5 text-center text-[11px]';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.brand}</td>;
    case 'leader':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.leader || '−'}</td>;
    case 'agentName':
      return <td key={key} className={`${base} font-semibold text-foreground`}>{row.agentName}</td>;
    case 'wallet':
      return <td key={key} className={`${base} text-foreground`}>{row.wallet}</td>;
    case 'amount':
      return <td key={key} className={`${base} tabular-nums text-teal-600 dark:text-teal-400 font-medium`}>{fmtNum(row.amount)}</td>;
    case 'type':
      return <td key={key} className={`${base} text-foreground`}>{row.type}</td>;
    case 'date':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.date}</td>;
    default:
      return null;
  }
}

export default function TopUpPage() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsMenuPos, setColumnsMenuPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  const [page, setPage] = useState(1);
  const rowsPerPage = 50;
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);

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

      // build agentName → leader lookup from opening sheet
      const leaderMap: Record<string, string> = {};
      if (agentText) {
        agentText.trim().split('\n').slice(1).forEach(line => {
          const cols = line.split(',');
          const name = rawVal(cols[0]);
          const leader = rawVal(cols[3]);
          if (name && leader) leaderMap[name.toUpperCase()] = leader;
        });
      }

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
            (brandGroups[name.toUpperCase()] ??= []).push(group);
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

      // One canonical brand per shop, not per row — if ANY of a shop's Top
      // Up rows carries an explicit "-<brand>" suffix, that's authoritative
      // for every one of its rows (a shop's brand doesn't change
      // transaction to transaction); only shops that NEVER carry a suffix
      // anywhere fall back to the cross-reference. Resolving this per-shop
      // first (instead of independently per row, each with its own
      // suffix-or-fallback check) is what keeps a shop's brand consistent —
      // e.g. "CALAMARI008" was showing as both B3 (one row's own suffix)
      // and M1 (another row with no suffix, cross-reference-resolved) on
      // this same page before this fix.
      const agentBrandOverride: Record<string, string> = {};
      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const toAgent = rawVal(cols[1]);
          if (!toAgent || toAgent === '-') return;
          const suffixBrand = extractBrandSuffix(toAgent);
          if (suffixBrand) {
            agentBrandOverride[stripBrandSuffix(toAgent).toUpperCase()] = suffixBrand;
          }
        });

      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const toAgent = rawVal(cols[1]);
          if (toAgent && toAgent !== '-') {
            const bareAgent = stripBrandSuffix(toAgent);
            const bareAgentKey = bareAgent.toUpperCase();
            topUp.push({
              agentName: bareAgent,
              wallet: rawVal(cols[4]),
              amount: rawVal(cols[2]),
              date: rawVal(cols[3]),
              type: rawVal(cols[5]),
              leader: leaderMap[bareAgentKey] || '−',
              brand: agentBrandOverride[bareAgentKey] ?? resolveBrand(brandGroups[bareAgentKey] ?? [], toAgent),
            });
          }
        });

      setTopUpRows(topUp.filter(row => isToday(row.date)));
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
  }, [searchTerm, brandFilter, sortColumn, sortDirection]);

  useEffect(() => {
    if (!brandMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        brandButtonRef.current && !brandButtonRef.current.contains(target) &&
        brandDropdownRef.current && !brandDropdownRef.current.contains(target)
      ) {
        setBrandMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [brandMenuOpen]);

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

  const brandOptions = useMemo(() => {
    return Array.from(new Set(topUpRows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [topUpRows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const searchedRows = topUpRows.filter((row) => {
    const haystack = `${row.agentName} ${row.wallet} ${row.amount} ${row.date} ${row.type}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const filteredRows = brandOptions.some((name) => brandFilter[name] === false)
    ? searchedRows.filter((row) => brandFilter[row.brand] !== false)
    : searchedRows;

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: TopUpRow) => {
        switch (sortColumn) {
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

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: TopUpRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand;
        case 'agentName':
          return row.agentName;
        case 'wallet':
          return row.wallet;
        case 'amount':
          return fmtNum(row.amount);
        case 'type':
          return row.type;
        case 'date':
          return row.date;
        default:
          return '';
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Top Up');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_TOPUP_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <PageHeader
        icon={PlusCircle}
        title="Top Up"
        centerSlot={<ProductSwitchTabs />}
        actions={<ThemeToggle />}
      />

      <main className={PAGE_MAIN_PADDING_CLASS}>

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable className="mt-3">
            <Toolbar className={TOOLBAR_ROW_CLASS}>
              <Toolbar.Left className={TOOLBAR_LEFT_CLASS}>
                {loading ? (
                  <div className="h-5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md bg-indigo-50 px-2.5 py-1 dark:bg-indigo-500/15">
                    <span className="text-[10px] font-medium text-indigo-600 dark:text-indigo-400">Records</span>
                    <span className="text-[11px] font-bold tabular-nums text-indigo-700 dark:text-indigo-300">{sortedRows.length.toLocaleString('en-PH')}</span>
                  </div>
                )}
                <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
                  {loading ? (
                    <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  ) : (
                    <>
                      <Search size={14} className="text-muted-foreground" />
                      <input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[10px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                        placeholder="Search shops or brands..."
                      />
                    </>
                  )}
                </div>
              </Toolbar.Left>
              <Toolbar.Right className={TOOLBAR_RIGHT_CLASS}>
                {loading && <div className="h-7 w-7 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={fetchData}
                    title="Refresh"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
                  </button>
                )}
                {loading && <div className="h-7 w-20 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={handleExport}
                    title="Export to Excel"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <Download size={13} />
                  </button>
                )}
                {loading && <div className="h-7 w-7 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
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
                      aria-controls="topup-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                    >
                      <Columns3 size={13} />
                    </button>
                    {columnsMenuOpen && typeof document !== 'undefined' && createPortal(
                      <div
                        ref={columnsMenuRef}
                        id="topup-columns-popover"
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
                          <button
                            type="button"
                            onClick={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                            className="flex w-full items-center justify-center rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-white/5"
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
            <div className="hidden flex-1 min-h-0 overflow-y-auto overflow-x-auto sm:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className={TABLE_STICKY_HEADER_CLASS}>
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: columnWidths[col.key] }}
                        className={headerCellClasses(col.key !== 'brand' && sortColumn === col.key)}>
                        {loading ? (
                          <div className="mx-auto h-5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : col.key === 'brand' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            <button
                              type="button"
                              ref={brandButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = brandButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  setBrandMenuPos({ top: rect.bottom + 4, left: rect.left });
                                }
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyBrandUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedBrandCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${brandMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {brandMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={brandDropdownRef}
                                style={{ position: 'fixed', top: brandMenuPos.top, left: brandMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Brand</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allBrandsChecked}
                                      onChange={() => {
                                        const nextValue = !allBrandsChecked;
                                        setBrandFilter(
                                          Object.fromEntries(brandOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {brandOptions.map((brand) => (
                                    <label key={brand} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isBrandChecked(brand)}
                                        onChange={() => {
                                          setBrandFilter((current) => ({ ...current, [brand]: !isBrandChecked(brand) }));
                                        }}
                                      />
                                      <span>{brand}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
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
                            className="flex w-full items-center justify-center gap-1.5 text-center transition hover:opacity-80"
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
                  {loading ? Array.from({ length: 18 }).map((_, i) => (
                    <tr key={i}>
                      {visibleColumns.map((col) => (
                        <td key={col.key} className="px-3 py-1.5">
                          <div className="mx-auto h-2.5 w-3/4 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </td>
                      ))}
                    </tr>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={i} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)}>
                        <EmptyState
                          title="No matching records found"
                          description="Try adjusting your search or filters."
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
                          <p className="truncate text-[11px] text-muted-foreground">{row.leader !== '−' ? `${row.leader} · ` : ''}{row.brand} · {row.wallet}</p>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{row.date}</span>
                      </div>

                      <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
                        <span className="text-[10px] font-medium text-muted-foreground">{row.type}</span>
                        <span className="text-lg font-bold tabular-nums text-teal-600 dark:text-teal-400">{fmtNum(row.amount)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="No matching records found"
                    description="Try adjusting your search or filters."
                  />
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
              />
            )}
          </DataTable>
        )}
      </main>
    </div>
  );
}
