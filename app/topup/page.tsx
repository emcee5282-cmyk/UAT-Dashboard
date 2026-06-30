'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, AlertCircle, Search, Loader2, ChevronUp, ChevronDown, Filter, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '../components/ThemeToggle';
import { rawVal, fmtNum } from '@/app/lib/format';

function getBrand(toAgent: string): string {
  if (!toAgent || toAgent === '-' || !toAgent.includes('-')) return '−';
  return toAgent.split('-').pop() || '−';
}

type TopUpRow = {
  agentName: string;
  toAgent: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
};

function parseAmount(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  return parseFloat(cleaned) || 0;
}

type SortColumn = '' | 'agentName' | 'wallet' | 'amount' | 'type' | 'date';
type ColumnKey = 'brand' | SortColumn;

const columns: { key: ColumnKey; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'agentName', label: 'Agent Name' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'amount', label: 'Amount' },
  { key: 'type', label: 'Type' },
  { key: 'date', label: 'Date' },
];

const columnWidths: Record<ColumnKey, string> = {
  '': '0%',
  brand: '12%',
  agentName: '23%',
  wallet: '15%',
  amount: '16%',
  type: '14%',
  date: '20%',
};

function headerCellClasses(active: boolean) {
  const color = active ? 'text-indigo-600 dark:text-indigo-400' : 'text-foreground';
  return `group text-center px-3 py-2 text-[12px] font-semibold whitespace-nowrap ${color}`;
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
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis px-3 py-1 text-center text-[9px]';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{getBrand(row.toAgent)}</td>;
    case 'agentName':
      return <td key={key} className={`${base} font-bold text-slate-900 dark:text-white`}>{row.agentName}</td>;
    case 'wallet':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.wallet}</td>;
    case 'amount':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{fmtNum(row.amount)}</td>;
    case 'type':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.type}</td>;
    case 'date':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.date}</td>;
    default:
      return null;
  }
}

export default function TopUpPage() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columns.map((col) => [col.key, true])) as Record<ColumnKey, boolean>
  );
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');

      const res = await fetch(`/api/stlm?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);

      const topUp: TopUpRow[] = [];

      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const agentLeft = rawVal(cols[0]);
          if (agentLeft && agentLeft !== '-') {
            topUp.push({
              agentName: agentLeft,
              toAgent: rawVal(cols[1]),
              wallet: rawVal(cols[2]),
              amount: rawVal(cols[3]),
              date: rawVal(cols[4]),
              type: rawVal(cols[5]),
            });
          }
        });

      setTopUpRows(topUp);
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
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
    return Array.from(new Set(topUpRows.map((row) => getBrand(row.toAgent)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [topUpRows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const searchedRows = topUpRows.filter((row) => {
    const haystack = `${row.agentName} ${row.toAgent} ${row.wallet} ${row.amount} ${row.date} ${row.type}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const filteredRows = brandOptions.some((name) => brandFilter[name] === false)
    ? searchedRows.filter((row) => brandFilter[getBrand(row.toAgent)] !== false)
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
          return getBrand(row.toAgent);
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
    <div className="min-h-screen w-full bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-medium text-foreground">Top Up</h1>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-1 w-1 rounded-full bg-emerald-500" />
              {loading ? '—' : (lastUpdated || '—')}
            </span>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning || loading}
              className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium text-indigo-600 border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="px-6 pt-4 pb-6">
        {loading && (
          <div
            className="fixed z-[9998] flex items-center justify-center bg-white/30 dark:bg-black/30"
            style={{ top: 0, left: '256px', right: 0, bottom: 0 }}
          >
            <Loader2 size={28} className="animate-spin text-indigo-500" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!error && (
          <div className="mb-1">
            {loading ? (
              <div className="h-2.5 w-24 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
            ) : (
              <span className="text-[11px] font-semibold text-foreground">Total Records: <span className="text-indigo-600">{sortedRows.length.toLocaleString('en-PH')}</span></span>
            )}
          </div>
        )}

        {!error && (
          <div className="bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="px-3 py-1 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex w-52 items-center gap-2 bg-white border border-border rounded-full px-4 py-1.5 dark:bg-[#2a2a2d]">
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
                <div className="relative">
                  {!loading && (
                    <button
                      type="button"
                      ref={filterButtonRef}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = filterButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          setFilterMenuPos({ top: rect.bottom + 8, left: rect.left });
                        }
                        setFilterMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyFilterActive ? 'border-indigo-200 text-indigo-700 dark:border-indigo-900/50 dark:text-indigo-300' : 'border-border text-foreground'}`}
                    >
                      <Filter size={14} />
                      Filter
                    </button>
                  )}
                  {filterMenuOpen && (
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
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {loading ? (
                  <div className="h-2.5 w-32 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Page {currentPage} of {totalPages}</span>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={currentPage === 1}
                      className="px-2.5 py-1.5 text-[10px] font-medium text-foreground border border-border rounded-lg hover:bg-white transition-colors disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={currentPage === totalPages}
                      className="px-2.5 py-1.5 text-[10px] font-medium text-foreground border border-border rounded-lg hover:bg-white transition-colors disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                )}
                {loading && <div className="h-7 w-20 animate-pulse rounded-xl bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={handleExport}
                    title="Export to Excel"
                    className="p-1.5 rounded-lg hover:bg-white transition-colors border border-border text-foreground"
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-scroll">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-[50] border-b border-border bg-white dark:bg-[#2a2a2d]">
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: columnWidths[col.key] }}
                        className={headerCellClasses(col.key !== 'brand' && sortColumn === col.key)}>
                        {col.key === 'brand' ? (
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
                  {pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={i} className="bg-white dark:bg-[#2a2a2d]">
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : <tr><td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-[9px] text-slate-500 dark:text-slate-400">No matching records found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
