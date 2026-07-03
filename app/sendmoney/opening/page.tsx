'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Download, Filter, RefreshCw, Search, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { parseSendMoneyOpeningCsv, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';

function fmtAbbrev(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtFull(num: number): string {
  return num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// App-wide money convention: negatives render red, in both Opening Balance
// and Security Deposit — not an Opening-only rule.
function MoneyText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const isNegative = value < 0;
  return (
    <span className={`font-medium tabular-nums ${isNegative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
      {isNegative ? '-' : ''}{fmtFull(Math.abs(value))}
    </span>
  );
}

function BrandBadge({ brand }: { brand: string | null }) {
  if (!brand) {
    return (
      <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        —
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md border border-[color:var(--product-accent)]/30 bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--product-accent)]">
      {brand}
    </span>
  );
}

const kpiValueClass = 'text-[28px] font-medium text-foreground mb-1 tabular-nums';
const kpiSkeleton = <div className="h-8 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 mb-1" />;

// Uniform button system: 36px height, 8px radius, 0.5px border, 13px label, 14px icons.
const BTN_BASE =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border-[0.5px] px-3 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_OUTLINE = `${BTN_BASE} border-border text-foreground hover:bg-muted`;
const BTN_PRIMARY = `${BTN_BASE} border-transparent bg-[color:var(--product-accent)] text-white hover:opacity-90`;

const ROWS_PER_PAGE = 50;

type SortColumn = 'agentName' | 'openingBalance' | 'securityDeposit';
type SortState = { column: SortColumn; direction: 'asc' | 'desc' } | null;
type OpeningFilter = 'all' | 'has' | 'none';

function compareNullableNumber(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  // Nulls always sort last, regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

function sortWithinGroup(rows: SendMoneyOpeningRow[], sort: SortState): SendMoneyOpeningRow[] {
  const sorted = [...rows];
  if (!sort) {
    sorted.sort((a, b) => a.agentName.localeCompare(b.agentName));
    return sorted;
  }
  sorted.sort((a, b) => {
    if (sort.column === 'agentName') {
      const cmp = a.agentName.localeCompare(b.agentName);
      return sort.direction === 'asc' ? cmp : -cmp;
    }
    return compareNullableNumber(a[sort.column], b[sort.column], sort.direction);
  });
  return sorted;
}

function sumNullable(rows: SendMoneyOpeningRow[], key: 'openingBalance' | 'securityDeposit'): number | null {
  const values = rows.map((r) => r[key]).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  column: SortColumn;
  sort: SortState;
  onSort: (column: SortColumn) => void;
  align?: 'left' | 'right';
}) {
  const activeAsc = sort?.column === column && sort.direction === 'asc';
  const activeDesc = sort?.column === column && sort.direction === 'desc';
  return (
    <th
      onClick={() => onSort(column)}
      className={`cursor-pointer select-none px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        <span className="flex flex-col -space-y-1">
          <ChevronUp size={9} className={activeAsc ? 'text-foreground' : 'text-muted-foreground/40'} />
          <ChevronDown size={9} className={activeDesc ? 'text-foreground' : 'text-muted-foreground/40'} />
        </span>
      </span>
    </th>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2 py-0.5 text-[10px] text-foreground dark:bg-[#2a2a2d]">
      {label}
      {/* -m-1 p-1 expands the actual hit target to ~18x18px without shifting
          layout — the bare 10px icon was too small to reliably click. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="-m-1 rounded-full p-1 text-muted-foreground hover:text-foreground"
      >
        <X size={10} />
      </button>
    </span>
  );
}

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<SendMoneyOpeningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [appliedBrandFilter, setAppliedBrandFilter] = useState<Record<string, boolean>>({});
  const [appliedLeaderFilter, setAppliedLeaderFilter] = useState<Record<string, boolean>>({});
  const [openingFilter, setOpeningFilter] = useState<OpeningFilter>('all');

  const [draftBrandFilter, setDraftBrandFilter] = useState<Record<string, boolean>>({});
  const [draftLeaderFilter, setDraftLeaderFilter] = useState<Record<string, boolean>>({});
  const [draftOpeningFilter, setDraftOpeningFilter] = useState<OpeningFilter>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const wasFilterMenuOpenRef = useRef(false);

  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setError('');
      const res = await fetch(`/api/sendmoney/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      setRows(parseSendMoneyOpeningCsv(text));
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
    } finally {
      // Only ever flips loading off — the KPI skeleton is a first-load-only
      // thing; refreshes keep showing the previous numbers until new ones land.
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // KPI cards always reflect the full dataset, never the filtered view.
  const accounts = rows.length;
  const totalOpening = useMemo(() => rows.reduce((sum, r) => sum + (r.openingBalance ?? 0), 0), [rows]);
  const totalSdp = useMemo(() => rows.reduce((sum, r) => sum + (r.securityDeposit ?? 0), 0), [rows]);
  const noOpeningCount = useMemo(() => rows.filter((r) => r.openingBalance === null).length, [rows]);

  const brandOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.brand).filter((b): b is string => b !== null))).sort(),
    [rows]
  );
  const leaderOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.leader))).sort(), [rows]);

  const brandFilterActive = brandOptions.some((b) => appliedBrandFilter[b] === false);
  const leaderFilterActive = leaderOptions.some((l) => appliedLeaderFilter[l] === false);
  const openingFilterActive = openingFilter !== 'all';
  const activeFilterCount = [brandFilterActive, leaderFilterActive, openingFilterActive].filter(Boolean).length;

  // Search + Filter panel (Brand/Leader/Opening) + the "No Opening Yet" KPI
  // toggle all AND together. The KPI toggle and the Opening radio are the
  // exact same `openingFilter` state — one source of truth, not two.
  const filteredRows = useMemo(() => {
    let list = rows;
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.agentName.toLowerCase().includes(q) ||
          r.leader.toLowerCase().includes(q) ||
          (r.brand ?? '').toLowerCase().includes(q)
      );
    }
    if (brandFilterActive) {
      list = list.filter((r) => r.brand !== null && appliedBrandFilter[r.brand] !== false);
    }
    if (leaderFilterActive) {
      list = list.filter((r) => appliedLeaderFilter[r.leader] !== false);
    }
    if (openingFilter === 'has') list = list.filter((r) => r.openingBalance !== null);
    if (openingFilter === 'none') list = list.filter((r) => r.openingBalance === null);
    return list;
  }, [rows, searchTerm, appliedBrandFilter, appliedLeaderFilter, openingFilter, brandFilterActive, leaderFilterActive]);

  // Stable base order for pagination: Leader A→Z, then Agent Name A→Z.
  // This is what makes group headers always land in A→Z order, and why a
  // leader's agents can span a page boundary (their count doesn't always
  // divide evenly into a page) — an accepted limitation, not a bug.
  const baseSortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    sorted.sort((a, b) => a.leader.localeCompare(b.leader) || a.agentName.localeCompare(b.agentName));
    return sorted;
  }, [filteredRows]);

  const totalPages = Math.max(1, Math.ceil(baseSortedRows.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  // Search/filters changing always sends the user back to page 1.
  useEffect(() => {
    setPage(1);
  }, [searchTerm, appliedBrandFilter, appliedLeaderFilter, openingFilter]);

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return baseSortedRows.slice(start, start + ROWS_PER_PAGE);
  }, [baseSortedRows, currentPage]);

  // Sort and group-collapse are per-page-view controls, not global — reset
  // whenever the page changes or the filtered/base row set changes.
  useEffect(() => {
    setSort(null);
    setExpandedGroups({});
  }, [currentPage, baseSortedRows]);

  const groups = useMemo(() => {
    const map = new Map<string, SendMoneyOpeningRow[]>();
    pagedRows.forEach((row) => {
      const list = map.get(row.leader) ?? [];
      list.push(row);
      map.set(row.leader, list);
    });
    return Array.from(map.entries()).map(([leader, groupRows]) => ({
      leader,
      rows: sortWithinGroup(groupRows, sort),
      openingSubtotal: sumNullable(groupRows, 'openingBalance'),
      depositSubtotal: sumNullable(groupRows, 'securityDeposit'),
    }));
  }, [pagedRows, sort]);

  const handleSort = (column: SortColumn) => {
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: 'asc' };
      if (current.direction === 'asc') return { column, direction: 'desc' };
      return null;
    });
  };

  const openFilterMenu = () => {
    setDraftBrandFilter(appliedBrandFilter);
    setDraftLeaderFilter(appliedLeaderFilter);
    setDraftOpeningFilter(openingFilter);
    const rect = filterButtonRef.current?.getBoundingClientRect();
    if (rect) {
      const dropdownWidth = 288;
      const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
      setFilterMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
    }
    setFilterMenuOpen(true);
  };

  // Escape / outside click closes the panel, discarding the draft (the draft
  // only ever gets committed via Apply, so simply not committing it *is* the
  // discard — nothing else to clean up).
  useEffect(() => {
    if (!filterMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        filterDropdownRef.current && !filterDropdownRef.current.contains(target) &&
        filterButtonRef.current && !filterButtonRef.current.contains(target)
      ) {
        setFilterMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [filterMenuOpen]);

  // Focus moves into the panel on open, and back to the Filter button on close.
  useEffect(() => {
    if (filterMenuOpen) {
      wasFilterMenuOpenRef.current = true;
      requestAnimationFrame(() => filterDropdownRef.current?.focus());
    } else if (wasFilterMenuOpenRef.current) {
      wasFilterMenuOpenRef.current = false;
      filterButtonRef.current?.focus();
    }
  }, [filterMenuOpen]);

  const handleApplyFilters = () => {
    setAppliedBrandFilter(draftBrandFilter);
    setAppliedLeaderFilter(draftLeaderFilter);
    setOpeningFilter(draftOpeningFilter);
    setFilterMenuOpen(false);
  };

  const handleClearAllDraft = () => {
    setDraftBrandFilter({});
    setDraftLeaderFilter({});
    setDraftOpeningFilter('all');
  };

  const clearAllFilters = () => {
    setSearchTerm('');
    setAppliedBrandFilter({});
    setAppliedLeaderFilter({});
    setOpeningFilter('all');
  };

  const selectedBrands = brandOptions.filter((b) => appliedBrandFilter[b] !== false);
  const selectedLeaders = leaderOptions.filter((l) => appliedLeaderFilter[l] !== false);

  const handleExport = useCallback(() => {
    const headers = ['Brand', 'Leader', 'Agent Name', 'Opening Balance', 'Security Deposit'];
    const data = baseSortedRows.map((r) => [
      r.brand ?? '—',
      r.leader,
      r.agentName,
      r.openingBalance ?? '',
      r.securityDeposit ?? '',
    ]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Opening Balance');
    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_OPENING_BALANCE_${datePart}_${timePart}.xlsx`);
  }, [baseSortedRows]);

  const hasActiveSearchOrFilter = searchTerm.trim() !== '' || activeFilterCount > 0;

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[5px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Opening Balance</h1>
            <span className="rounded-full bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[color:var(--product-accent)]">
              Send Money
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 dark:bg-emerald-500/10 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="tabular-nums text-[9px] font-medium text-emerald-700 dark:text-emerald-400">{lastUpdated || '—'}</span>
            </div>
            <button type="button" onClick={fetchData} disabled={spinning} className={BTN_OUTLINE}>
              <RefreshCw size={14} className={spinning ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            {error}
          </div>
        )}

        {!error && (
          <div className="flex gap-4 mb-6 shrink-0">
            <div className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]">
              <p className="text-xs text-muted-foreground font-medium mb-1">Accounts</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{accounts.toLocaleString('en-PH')}</p>}
            </div>

            <div
              className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]"
              title={loading ? undefined : fmtFull(totalOpening)}
            >
              <p className="text-xs text-muted-foreground font-medium mb-1">Total Opening Balance</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{fmtAbbrev(totalOpening)}</p>}
            </div>

            <div
              className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]"
              title={loading ? undefined : fmtFull(totalSdp)}
            >
              <p className="text-xs text-muted-foreground font-medium mb-1">Total Security Deposit</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{fmtAbbrev(totalSdp)}</p>}
            </div>

            <button
              type="button"
              aria-pressed={openingFilter === 'none'}
              onClick={() => setOpeningFilter((current) => (current === 'none' ? 'all' : 'none'))}
              className={`text-left rounded-xl border p-5 flex-1 min-w-0 transition-colors ${
                openingFilter === 'none'
                  ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-active-bg)]'
                  : 'border-[color:var(--product-accent)]/30 bg-[color:var(--product-accent-soft)] hover:bg-[color:var(--product-accent-active-bg)]'
              }`}
            >
              <p className="text-xs font-medium mb-1 text-[color:var(--product-accent)]">No Opening Yet</p>
              {loading ? kpiSkeleton : <p className={`${kpiValueClass} text-[color:var(--product-accent)]`}>{noOpeningCount.toLocaleString('en-PH')}</p>}
            </button>
          </div>
        )}

        {!error && (
          <div className="flex-1 flex flex-col min-h-0 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-full max-w-[320px] items-center gap-2 rounded-lg border-[0.5px] border-border bg-white px-3 dark:bg-[#2a2a2d]">
                  <Search size={14} className="shrink-0 text-muted-foreground" />
                  <input
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search agent, leader, brand..."
                    className="w-full flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                  />
                  {searchTerm && (
                    <button type="button" onClick={() => setSearchTerm('')} className="shrink-0 text-muted-foreground hover:text-foreground">
                      <X size={13} />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  ref={filterButtonRef}
                  aria-haspopup="dialog"
                  aria-expanded={filterMenuOpen}
                  onClick={() => (filterMenuOpen ? setFilterMenuOpen(false) : openFilterMenu())}
                  className={`${BTN_OUTLINE} ${activeFilterCount > 0 ? 'border-[color:var(--product-accent)] text-[color:var(--product-accent)]' : ''}`}
                >
                  <Filter size={14} />
                  Filter
                  {activeFilterCount > 0 && (
                    <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[color:var(--product-accent)] px-1 text-[9px] font-semibold leading-none text-white">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage === 1}
                  className={BTN_OUTLINE}
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={currentPage === totalPages}
                  className={BTN_OUTLINE}
                >
                  Next
                </button>
                <button type="button" onClick={handleExport} title="Export" className={BTN_OUTLINE}>
                  <Download size={14} />
                </button>
              </div>
            </div>

            {filterMenuOpen && typeof document !== 'undefined' && createPortal(
              <div
                ref={filterDropdownRef}
                tabIndex={-1}
                role="dialog"
                aria-label="Filter options"
                style={{ position: 'fixed', top: filterMenuPos.top, left: filterMenuPos.left }}
                className="z-[9999] flex max-h-[70vh] w-72 flex-col rounded-xl border border-border bg-white shadow-xl outline-none dark:bg-[#2a2a2d]"
              >
                <div className="flex-1 overflow-y-auto p-3">
                  <div className="mb-3">
                    <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Brand</p>
                    <div className="max-h-32 space-y-0.5 overflow-y-auto">
                      {brandOptions.map((b) => (
                        <label key={b} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-foreground hover:bg-muted/60">
                          <input
                            type="checkbox"
                            checked={draftBrandFilter[b] !== false}
                            onChange={() => setDraftBrandFilter((c) => ({ ...c, [b]: c[b] === false }))}
                          />
                          {b}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="mb-3">
                    <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Leader</p>
                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                      {leaderOptions.map((l) => (
                        <label key={l} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-foreground hover:bg-muted/60">
                          <input
                            type="checkbox"
                            checked={draftLeaderFilter[l] !== false}
                            onChange={() => setDraftLeaderFilter((c) => ({ ...c, [l]: c[l] === false }))}
                          />
                          {l}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Opening</p>
                    <div className="space-y-0.5">
                      {(['all', 'has', 'none'] as const).map((val) => (
                        <label key={val} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-foreground hover:bg-muted/60">
                          <input
                            type="radio"
                            name="openingFilter"
                            checked={draftOpeningFilter === val}
                            onChange={() => setDraftOpeningFilter(val)}
                          />
                          {val === 'all' ? 'All' : val === 'has' ? 'Has opening' : 'No opening'}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3">
                  <button type="button" onClick={handleClearAllDraft} className={BTN_OUTLINE}>
                    Clear all
                  </button>
                  <button type="button" onClick={handleApplyFilters} className={BTN_PRIMARY}>
                    Apply
                  </button>
                </div>
              </div>,
              document.body
            )}

            {activeFilterCount > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/10 px-4 py-2">
                {brandFilterActive && (
                  <FilterChip
                    label={`Brand: ${selectedBrands.slice(0, 2).join(', ')}${selectedBrands.length > 2 ? ` +${selectedBrands.length - 2}` : ''}`}
                    onRemove={() => setAppliedBrandFilter({})}
                  />
                )}
                {leaderFilterActive && (
                  <FilterChip
                    label={`Leader: ${selectedLeaders.slice(0, 2).join(', ')}${selectedLeaders.length > 2 ? ` +${selectedLeaders.length - 2}` : ''}`}
                    onRemove={() => setAppliedLeaderFilter({})}
                  />
                )}
                {openingFilterActive && (
                  <FilterChip
                    label={openingFilter === 'has' ? 'Has Opening' : 'No Opening'}
                    onRemove={() => setOpeningFilter('all')}
                  />
                )}
              </div>
            )}

            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-[50] border-b border-border bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:bg-[#2a2a2d] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Brand</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">Leader</th>
                    <SortHeader label="Agent Name" column="agentName" sort={sort} onSort={handleSort} align="left" />
                    <SortHeader label="Opening Balance" column="openingBalance" sort={sort} onSort={handleSort} />
                    <SortHeader label="Security Deposit" column="securityDeposit" sort={sort} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="px-4 py-3" colSpan={5}>
                          <div className="h-3 w-full animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </td>
                      </tr>
                    ))
                  ) : groups.length === 0 ? (
                    <tr>
                      {/* Filter-specific empty state — never EmptyProductState, which means
                          "no data source connected" and isn't true here. */}
                      <td colSpan={5} className="px-4 py-10 text-center">
                        <p className="mb-3 text-xs text-muted-foreground">
                          {hasActiveSearchOrFilter ? 'No agents match your filters.' : 'No accounts found.'}
                        </p>
                        {hasActiveSearchOrFilter && (
                          <button type="button" onClick={clearAllFilters} className={`${BTN_OUTLINE} mx-auto`}>
                            Clear filters
                          </button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    groups.map((group) => {
                      const isExpanded = expandedGroups[group.leader] !== false;
                      return (
                        <Fragment key={group.leader}>
                          <tr
                            onClick={() => setExpandedGroups((current) => ({ ...current, [group.leader]: !isExpanded }))}
                            className="cursor-pointer bg-[color:var(--product-accent-soft)]"
                          >
                            <td colSpan={5} className="px-4 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                                  <ChevronDown
                                    size={13}
                                    className={`shrink-0 text-[color:var(--product-accent)] transition-transform duration-150 ${isExpanded ? '' : '-rotate-90'}`}
                                  />
                                  {group.leader}
                                  <span className="font-normal text-muted-foreground">({group.rows.length})</span>
                                </span>
                                <span
                                  className="text-[11px] font-medium text-muted-foreground"
                                  title="Totals for rows on this page only."
                                >
                                  Page subtotal <MoneyText value={group.openingSubtotal} /> · Deposit{' '}
                                  <MoneyText value={group.depositSubtotal} />
                                </span>
                              </div>
                            </td>
                          </tr>
                          {isExpanded &&
                            group.rows.map((row) => (
                              <tr key={row.agentName} className="border-b border-border last:border-0 hover:bg-muted/10 transition-colors">
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <BrandBadge brand={row.brand} />
                                </td>
                                <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{row.leader}</td>
                                <td className="px-4 py-3 text-xs font-medium text-foreground whitespace-nowrap">{row.agentName}</td>
                                <td className="px-4 py-3 text-xs text-right whitespace-nowrap">
                                  <MoneyText value={row.openingBalance} />
                                </td>
                                <td className="px-4 py-3 text-xs text-right whitespace-nowrap">
                                  <MoneyText value={row.securityDeposit} />
                                </td>
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
