'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, AlertCircle, Search, Loader2, Filter, ChevronUp, ChevronDown } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';

type Row = {
  agentName: string;
  openingBal: number;
  sdp: number;
  leader: string;
  brand: string;
};

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

type SortColumn = '' | 'brand' | 'leader' | 'agentName' | 'openingBal' | 'sdp';

const columns: { key: SortColumn; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'leader', label: 'Leader' },
  { key: 'agentName', label: 'Agent Name' },
  { key: 'openingBal', label: 'Opening Bal.' },
  { key: 'sdp', label: 'SDP' },
];

function headerCellClasses(active: boolean) {
  const bg = active ? 'bg-indigo-50 dark:bg-indigo-500/10' : '';
  const color = active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400';
  const rounded = active ? 'rounded-md' : '';
  return `whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold ${bg} ${color} ${rounded}`;
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-40">
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

export default function Summary() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');
      setRows([]);
      const [res, balRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
      ]);
      if (!res.ok || !balRes.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      const balText = await balRes.text();

      const brandGroups = new Map<string, string[]>();
      balText
        .trim()
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '')
        .forEach((line) => {
          const cols = line.split(',');
          const walletName = cols[1]?.replace(/"/g, '').trim();
          const group = cols[6]?.replace(/"/g, '').trim();
          if (!walletName || walletName === '-') return;
          const groups = brandGroups.get(walletName) ?? [];
          groups.push(group);
          brandGroups.set(walletName, groups);
        });

      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const cols = line.split(',');
          const agentName = cols[0]?.replace(/"/g, '').trim();
          return {
            agentName,
            openingBal: clean(cols[1]),
            sdp: clean(cols[2]),
            leader: cols[3]?.replace(/"/g, '').trim(),
            brand: resolveBrand(brandGroups.get(agentName) ?? [], agentName),
          };
        });
      setRows(parsed);
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

  const brandOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));

  const searchedRows = rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${fmt(row.openingBal)} ${fmt(row.sdp)}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const filteredRows = brandOptions.some((name) => brandFilter[name] === false)
    ? searchedRows.filter((row) => brandFilter[row.brand] !== false)
    : searchedRows;

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

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Opening Balance</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
              <Search size={12} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="w-32 bg-transparent outline-none md:w-48"
                placeholder="Search"
              />
            </label>
            <span className="flex items-center gap-1.5 text-[11px] text-[#6b7280] dark:text-[#a0a0a0]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {lastUpdated || '—'}
            </span>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning}
              className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] font-medium text-[#6b7280] transition-all disabled:opacity-50 dark:border-[#3a3a3d] dark:text-[#a0a0a0]"
            >
              <RefreshCw size={12} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className={`relative space-y-2 p-3 ${loading ? 'pointer-events-none' : ''}`}>
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
          <div className="rounded-xl border border-[#e5e5e7] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
              {loading ? (
                <div className="h-2.5 w-24 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
              ) : (
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{sortedRows.length} agents</span>
              )}
              {loading ? (
                <div className="h-2.5 w-32 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
              ) : (
                <div className="flex items-center gap-1.5 rounded-xl border border-[#e5e5e7] px-2 py-0.5 dark:border-[#3a3a3d]">
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={currentPage === 1}
                    className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300"
                  >
                    Previous
                  </button>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">Page {currentPage} of {totalPages}</span>
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]">
                  <tr className="border-b border-slate-200 dark:border-[#3a3a3d]">
                    {columns.map((col) => (
                      <th key={col.key} className={headerCellClasses(sortColumn === col.key)}>
                        {col.key === 'brand' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (sortColumn === 'brand') {
                                  setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setSortColumn('brand');
                                  setSortDirection('asc');
                                }
                              }}
                              className="flex items-center gap-1 text-center transition hover:opacity-80"
                            >
                              <span>{col.label}</span>
                              <SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                            </button>
                            <button
                              type="button"
                              ref={brandButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = brandButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setBrandMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              <Filter size={12} className={anyBrandUnchecked ? 'opacity-100' : 'opacity-70'} />
                            </button>
                            {brandMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={brandDropdownRef}
                                style={{ position: 'fixed', top: brandMenuPos.top, left: brandMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Filter</div>
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
                  {pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={i} className="bg-white dark:bg-[#2a2a2d]">
                      <td className="px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.brand}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.leader}</td>
                      <td className="px-3 py-2 text-center text-[9px] font-bold text-slate-900 dark:text-white">{row.agentName}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmt(row.openingBal)}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmt(row.sdp)}</td>
                    </tr>
                  )) : <tr><td colSpan={5} className="px-3 py-8 text-center text-[9px] text-slate-500 dark:text-slate-400">No matching agents found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}