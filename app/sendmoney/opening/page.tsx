'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, AlertCircle, Search, Filter, ChevronUp, ChevronDown, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '@/app/components/ThemeToggle';
import { parseSendMoneyOpeningCsv, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';

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

type ColumnKey = 'brand' | 'leader' | 'agentName' | 'openingBalance' | 'securityDeposit';
type SortColumn = '' | ColumnKey;

const columns: { key: ColumnKey; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'leader', label: 'Leader' },
  { key: 'agentName', label: 'Agent Name' },
  { key: 'openingBalance', label: 'Opening Balance' },
  { key: 'securityDeposit', label: 'Security Deposit' },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '18%',
  leader: '20%',
  agentName: '22%',
  openingBalance: '20%',
  securityDeposit: '20%',
};

function headerCellClasses() {
  return 'group text-center px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground';
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
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>('leader');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columns.map((col) => [col.key, true])) as Record<ColumnKey, boolean>
  );
  const rowsPerPage = 50;
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const leaderDropdownRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

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
      setError('');
      setRows([]);
      const res = await fetch(`/api/sendmoney/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      setRows(parseSendMoneyOpeningCsv(text));
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
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
    if (!filterMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        filterButtonRef.current && !filterButtonRef.current.contains(target) &&
        filterDropdownRef.current && !filterDropdownRef.current.contains(target)
      ) {
        setFilterMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [filterMenuOpen]);

  const visibleColumns = useMemo(() => columns.filter((col) => columnVisibility[col.key]), [columnVisibility]);
  const allColumnsChecked = columns.every((col) => columnVisibility[col.key]);
  const anyColumnHidden = columns.some((col) => !columnVisibility[col.key]);
  const anyFilterActive = anyColumnHidden;

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
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Opening Balance</h1>
            <span className="rounded-full bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[color:var(--product-accent)]">
              Send Money
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 dark:bg-emerald-500/10 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="tabular-nums text-[9px] font-medium text-emerald-700 dark:text-emerald-400">{loading ? '—' : (lastUpdated || '—')}</span>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-500 sm:hidden" />
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning || loading}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">

        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!error && (
          <div className="flex-1 flex flex-col min-h-0 mt-3 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
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
                <div className="relative">
                  {!loading && (
                    <button
                      type="button"
                      ref={filterButtonRef}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = filterButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          const dropdownWidth = 224;
                          const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                          setFilterMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                        }
                        setFilterMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyFilterActive ? 'border-[color:var(--product-accent)] text-[color:var(--product-accent)]' : 'border-border text-foreground'}`}
                    >
                      <Filter size={14} />
                      Filter
                    </button>
                  )}
                  {filterMenuOpen && typeof document !== 'undefined' && createPortal(
                    <div
                      ref={filterDropdownRef}
                      style={{ position: 'fixed', top: filterMenuPos.top, left: filterMenuPos.left }}
                      className="z-[9999] w-56 max-h-[70vh] overflow-y-auto rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Columns</div>
                      <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={allColumnsChecked}
                          onChange={() => {
                            const nextValue = !allColumnsChecked;
                            setColumnVisibility(
                              Object.fromEntries(columns.map((col) => [col.key, nextValue])) as Record<ColumnKey, boolean>
                            );
                          }}
                        />
                        <span>Check All</span>
                      </label>
                      {columns.map((col) => (
                        <label key={col.key} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                          <input
                            type="checkbox"
                            checked={columnVisibility[col.key]}
                            onChange={() => {
                              setColumnVisibility((current) => ({ ...current, [col.key]: !current[col.key] }));
                            }}
                          />
                          <span>{col.label}</span>
                        </label>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {loading ? (
                  <div className="h-6 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{currentPage} / {totalPages}</span>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={currentPage === 1}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={currentPage === totalPages}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Next
                    </button>
                  </div>
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
              </div>
            </div>
            <div className="hidden relative flex-1 min-h-0 overflow-y-auto overflow-x-auto sm:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#252528] border-b border-border shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
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
                  )) : <tr><td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-[11px] text-muted-foreground">No matching agents found.</td></tr>}
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
                  <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                    No matching agents found.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
