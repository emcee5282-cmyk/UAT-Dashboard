'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
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

const ROWS_PER_PAGE = 50;

type SortColumn = 'agentName' | 'openingBalance' | 'securityDeposit';
type SortState = { column: SortColumn; direction: 'asc' | 'desc' } | null;

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

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<SendMoneyOpeningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [noOpeningFilterActive, setNoOpeningFilterActive] = useState(false);
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

  const accounts = rows.length;
  const totalOpening = useMemo(() => rows.reduce((sum, r) => sum + (r.openingBalance ?? 0), 0), [rows]);
  const totalSdp = useMemo(() => rows.reduce((sum, r) => sum + (r.securityDeposit ?? 0), 0), [rows]);
  const noOpeningCount = useMemo(() => rows.filter((r) => r.openingBalance === null).length, [rows]);

  // Filter first, then paginate the filtered set — page count itself shrinks
  // when the "No Opening Yet" toggle is active.
  const filteredRows = useMemo(
    () => (noOpeningFilterActive ? rows.filter((r) => r.openingBalance === null) : rows),
    [rows, noOpeningFilterActive]
  );

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

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return baseSortedRows.slice(start, start + ROWS_PER_PAGE);
  }, [baseSortedRows, currentPage]);

  // Sort is a per-page-view control, not a global sort applied before
  // pagination — reset it whenever the page (or the underlying data) changes.
  useEffect(() => {
    setSort(null);
    setExpandedGroups({});
  }, [currentPage, rows]);

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
            <button
              type="button"
              onClick={fetchData}
              disabled={spinning}
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
              aria-pressed={noOpeningFilterActive}
              onClick={() => setNoOpeningFilterActive((current) => !current)}
              className={`text-left rounded-xl border p-5 flex-1 min-w-0 transition-colors ${
                noOpeningFilterActive
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
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 border-b border-border bg-muted/10">
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
                      <td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">
                        No matching accounts found.
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

            <div className="shrink-0 flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2">
              <span className="text-[10px] text-muted-foreground">
                {baseSortedRows.length.toLocaleString('en-PH')} accounts
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage === 1}
                  className="rounded-lg border border-border px-2.5 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={currentPage === totalPages}
                  className="rounded-lg border border-border px-2.5 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
