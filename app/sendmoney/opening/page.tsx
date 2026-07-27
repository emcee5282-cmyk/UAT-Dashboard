'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, Columns3, ChevronUp, ChevronDown, Download, Upload, BookOpen, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import PageHeader from '@/app/components/PageHeader';
import ProductSwitchTabs from '@/app/components/ProductSwitchTabs';
import ThemeToggle from '@/app/components/ThemeToggle';
import Toolbar from '@/app/components/Toolbar';
import DataTable from '@/app/components/DataTable';
import TableFooter from '@/app/components/TableFooter';
import EmptyState from '@/app/components/EmptyState';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import UploadExcelModal from '@/app/components/UploadExcelModal';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { parseSendMoneyOpeningCsv, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';
import { extractSendMoneyShopName } from '@/app/lib/realShopName';
import { TABLE_STICKY_HEADER_CLASS, TABLE_HEADER_CELL_CLASS, TOOLBAR_ROW_CLASS, TOOLBAR_LEFT_CLASS, TOOLBAR_RIGHT_CLASS } from '@/app/design-system/table';
import { PAGE_MAIN_PADDING_CLASS } from '@/app/design-system/spacing';
import { getPreference, setPreference } from '@/app/lib/preferences';

// Zero and "not set" (blank/null source cell) both render as the same dash —
// visually identical to Cashout's fmt(), but null stays a distinct value
// upstream (see app/lib/sendMoneyOpening.ts) for counts/sums that need to
// tell "no opening balance" apart from "opening balance of exactly 0".
function fmt(value: number | null): string {
  if (value === null || value === 0) return '—';
  return Math.abs(value).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Permanent column identifiers — same Enterprise Table V2 pattern as
// app/stlm/page.tsx (the canonical reference); this page gets its own
// COLUMN_IDS rather than sharing Settlement's.
const COLUMN_IDS = {
  BRAND: 'brand',
  LEADER: 'leader',
  AGENT_NAME: 'agentName',
  OPENING_BALANCE: 'openingBalance',
  SECURITY_DEPOSIT: 'securityDeposit',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];
type SortColumn = '' | ColumnKey;

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
  { key: COLUMN_IDS.OPENING_BALANCE, label: 'Opening Balance', visible: true, sortable: true, hideable: true, align: 'center' },
  { key: COLUMN_IDS.SECURITY_DEPOSIT, label: 'Security Deposit', visible: true, sortable: true, hideable: true, align: 'center' },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'sendMoneyOpeningColumnVisibility';

const columns: { key: ColumnKey; label: string }[] = DEFAULT_COLUMNS.map((col) => ({ key: col.key, label: col.label }));

const columnWidths: Record<ColumnKey, string> = {
  brand: '18%',
  leader: '20%',
  agentName: '22%',
  openingBalance: '20%',
  securityDeposit: '20%',
};

function headerCellClasses() {
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
    <ChevronUp size={10} className="text-[color:var(--product-accent)]" />
  ) : (
    <ChevronDown size={10} className="text-[color:var(--product-accent)]" />
  );
}

function renderCell(row: SendMoneyOpeningRow, key: ColumnKey) {
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis px-3 py-1.5 text-center text-[11px]';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.brand ?? '—'}</td>;
    case 'leader':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.leader}</td>;
    case 'agentName':
      return <td key={key} className={`${base} font-semibold text-foreground`}>{row.agentName}</td>;
    case 'openingBalance':
      return <td key={key} className={`${base} tabular-nums text-foreground`}>{fmt(row.openingBalance)}</td>;
    case 'securityDeposit':
      return <td key={key} className={`${base} tabular-nums text-foreground`}>{fmt(row.securityDeposit)}</td>;
    default:
      return null;
  }
}

function compareNullableNumber(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  // Nulls always sort last, regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<SendMoneyOpeningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>('leader');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  // Column Visibility (Enterprise Table V2) — same model/persistence as
  // app/stlm/page.tsx: read saved preference once on mount (gated by
  // `mounted`), written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsMenuPos, setColumnsMenuPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  const rowsPerPage = 50;

  // Next-day "assumed balance" upload — same feature as Cashout's own
  // Opening page (app/summary/page.tsx), writing into the same "Estimated
  // Opening" sheet tab's reserved Send Money column block instead of a
  // separate sheet. See app/components/UploadExcelModal.tsx for the shared
  // workflow (shared verbatim with Cashout's Opening page).
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const leaderDropdownRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    // Refresh always stays visibly "loading" for at least this long, even if
    // the fetch itself is too fast to notice — otherwise a quick response
    // reads as "nothing happened." Never caps a slow fetch, only pads a fast
    // one up to this floor.
    const MIN_SPIN_MS = 600;
    const startedAt = Date.now();
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);
      const res = await fetch(`/api/sendmoney/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const text = await res.text();
      setRows(parseSendMoneyOpeningCsv(text));
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
  }, [searchTerm, brandFilter, leaderFilter, sortColumn, sortDirection]);

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
    if (!leaderMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        leaderButtonRef.current && !leaderButtonRef.current.contains(target) &&
        leaderDropdownRef.current && !leaderDropdownRef.current.contains(target)
      ) {
        setLeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [leaderMenuOpen]);

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
    return Array.from(new Set(rows.map((row) => row.brand).filter((b): b is string => b !== null))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const leaderOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const allLeadersChecked = leaderOptions.every((name) => isLeaderChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;

  const searchedRows = rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${fmt(row.openingBalance)} ${fmt(row.securityDeposit)}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const brandedRows = brandOptions.some((name) => brandFilter[name] === false)
    ? searchedRows.filter((row) => row.brand !== null && brandFilter[row.brand] !== false)
    : searchedRows;

  const filteredRows = leaderOptions.some((name) => leaderFilter[name] === false)
    ? brandedRows.filter((row) => leaderFilter[row.leader] !== false)
    : brandedRows;

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const list = [...filteredRows];
    list.sort((a, b) => {
      if (sortColumn === 'openingBalance' || sortColumn === 'securityDeposit') {
        return compareNullableNumber(a[sortColumn], b[sortColumn], sortDirection);
      }
      const getValue = (row: SendMoneyOpeningRow) => {
        switch (sortColumn) {
          case 'brand':
            return (row.brand ?? '').toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'agentName':
            return row.agentName.toLowerCase();
          default:
            return '';
        }
      };
      const comparison = getValue(a).localeCompare(getValue(b));
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
    const getExportValue = (row: SendMoneyOpeningRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand ?? '—';
        case 'leader':
          return row.leader;
        case 'agentName':
          return row.agentName;
        case 'openingBalance':
          return fmt(row.openingBalance);
        case 'securityDeposit':
          return fmt(row.securityDeposit);
        default:
          return '';
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Opening Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_OPENING_BALANCE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <PageHeader
        icon={BookOpen}
        title="Opening"
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
                  <div className="flex items-center gap-1.5 rounded-md bg-[color:var(--product-accent-soft)] px-2.5 py-1">
                    <span className="text-[10px] font-medium text-[color:var(--product-accent)]">Accounts</span>
                    <span className="text-[11px] font-bold tabular-nums text-[color:var(--product-accent)]">{sortedRows.length.toLocaleString('en-PH')}</span>
                  </div>
                )}
                <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
                  {loading ? (
                    <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  ) : (
                    <>
                      <Search size={13} className="shrink-0 text-muted-foreground" />
                      <input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[10px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                        placeholder="Search agents or brands..."
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
                {loading && <div className="h-7 w-7 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={() => setUploadModalOpen(true)}
                    title="Upload Excel Data"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <Upload size={13} />
                  </button>
                )}
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
                      aria-controls="sendmoney-opening-columns-popover"
                      aria-label="Columns"
                      title="Columns"
                      className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                    >
                      <Columns3 size={13} />
                    </button>
                    {columnsMenuOpen && typeof document !== 'undefined' && createPortal(
                      <div
                        ref={columnsMenuRef}
                        id="sendmoney-opening-columns-popover"
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
                          {/* Hardcoded teal, not var(--product-accent): this popover
                              portals to document.body, a sibling of the
                              [data-product="sendmoney"] div the variable is scoped
                              to (see globals.css), so the var resolves to nothing
                              here — confirmed via computed-style check. */}
                          <button
                            type="button"
                            onClick={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                            className="flex w-full items-center justify-center rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-[#0d9488] transition-colors hover:bg-[rgba(13,148,136,0.08)] dark:hover:bg-[rgba(45,212,191,0.12)]"
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
            <div className="hidden relative flex-1 min-h-0 overflow-y-auto overflow-x-auto sm:block">
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
                        className={headerCellClasses()}>
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
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
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
                            {brandMenuOpen && (
                              <div
                                ref={brandDropdownRef}
                                className="absolute top-full left-0 mt-1 z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
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
                              </div>
                            )}
                          </div>
                        ) : col.key === 'leader' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            <button
                              type="button"
                              ref={leaderButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                setLeaderMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyLeaderUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyLeaderUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedLeaderCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${leaderMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {leaderMenuOpen && (
                              <div
                                ref={leaderDropdownRef}
                                className="absolute top-full left-0 mt-1 z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Leader</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allLeadersChecked}
                                      onChange={() => {
                                        const nextValue = !allLeadersChecked;
                                        setLeaderFilter(
                                          Object.fromEntries(leaderOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {leaderOptions.map((leader) => (
                                    <label key={leader} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isLeaderChecked(leader)}
                                        onChange={() => {
                                          setLeaderFilter((current) => ({ ...current, [leader]: !isLeaderChecked(leader) }));
                                        }}
                                      />
                                      <span>{leader}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
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
                    <tr key={row.agentName || i} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)}>
                        <EmptyState
                          title="No matching agents found"
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
                    <div key={row.agentName || i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{row.leader}{row.brand ? ` · ${row.brand}` : ''}</p>
                        </div>
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
                        <div>
                          <p className="text-[9px] font-medium text-muted-foreground">Opening Balance</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.openingBalance)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium text-muted-foreground">Security Deposit</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.securityDeposit)}</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="No matching agents found"
                    description="Try adjusting your search or filters."
                  />
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
              />
            )}
          </DataTable>
        )}
      </main>

      <UploadExcelModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onImported={fetchData}
        apiBasePath="/api/sendmoney/opening"
        extractShopName={extractSendMoneyShopName}
        skipShopNames={['OLD']}
        dataProduct="sendmoney"
        accent={{
          dragActiveBorder: 'border-[color:var(--product-accent)]',
          dragActiveBg: 'bg-[color:var(--product-accent-soft)]',
          dragActiveIcon: 'text-[color:var(--product-accent)]',
          progressBarFill: 'bg-[color:var(--product-accent)]',
          primaryButton: 'bg-[color:var(--product-accent)] hover:opacity-90',
          shopBadgeBg: 'bg-[color:var(--product-accent-soft)]',
          shopBadgeText: 'text-[color:var(--product-accent)]',
          highlightedRowBg: 'bg-[color:var(--product-accent-soft)]',
        }}
      />
    </div>
  );
}
