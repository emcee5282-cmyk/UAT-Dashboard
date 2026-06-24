'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, Wallet2 } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';

type OpeningRow = {
  agentName: string;
  openingBal: string;
  sdp: string;
  leader: string;
};

type BalRow = {
  walletName: string;
  totalDP: string;
  totalWD: string;
};

type MergedRow = OpeningRow & {
  agentTotalDP: number;
  agentTotalWD: number;
  totalTopUp: number;
  totalStlm: number;
};

function rawVal(val: string): string {
  return (val ?? '').replace(/"/g, '').trim() || '-';
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function fmtNum(val: string): string {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return '-';
  const num = parseFloat(cleaned);
  if (isNaN(num)) return '-';
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active') return 'text-emerald-600 dark:text-emerald-400';
  if (s === 'inactive') return 'text-rose-600 dark:text-rose-400';
  return 'text-slate-500 dark:text-slate-400';
}

function accountStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'dp + wd') return 'text-emerald-600 dark:text-emerald-400';
  if (s === 'dp only') return 'text-cyan-600 dark:text-cyan-400';
  if (s === 'wd only') return 'text-amber-600 dark:text-amber-400';
  return 'text-slate-500 dark:text-slate-400';
}

export default function AgentBalance() {
  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');
      setRows([]);

      const [openingRes, balRes, stlmRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/stlm?t=${Date.now()}`),
      ]);

      if (!openingRes.ok || !balRes.ok || !stlmRes.ok) throw new Error('Failed to fetch');

      const openingText = await openingRes.text();
      const balText = await balRes.text();
      const stlmText = await stlmRes.text();

      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          openingBal: rawVal(row[1]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== 'OLD');

      const openingMap = new Map<string, OpeningRow>();
      openingRows.forEach((row) => {
        openingMap.set(row.agentName, row);
      });

      const balRows = parseCsvLines(balText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[1]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      balRows.forEach((bal) => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
        balanceTotals.set(name, {
          dp: existing.dp + dp,
          wd: existing.wd + wd,
        });
      });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = rawVal(row[0]);
          const topUpAmount = rawVal(row[3]);
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-') {
            const amount = parseFloat(topUpAmount.replace(/,/g, '')) || 0;
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = rawVal(row[7]);
          const stlmAmount = rawVal(row[8]);
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-') {
            const amount = parseFloat(stlmAmount.replace(/,/g, '')) || 0;
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: MergedRow[] = openingRows.map((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        return {
          ...opening,
          agentTotalDP: totals.dp,
          agentTotalWD: totals.wd,
          totalTopUp: topUpTotals.get(opening.agentName) ?? 0,
          totalStlm: stlmTotals.get(opening.agentName) ?? 0,
        };
      });

      setRows(merged);
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
  }, [searchTerm]);

  const columns = [
    'Leader',
    'Agent Name',
    'Opening',
    'Total DP',
    'Total WD',
  ];

  const filteredRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return rows;

    return rows.filter((row) => {
      const haystack = `${row.leader} ${row.agentName} ${row.openingBal} ${row.sdp}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = filteredRows.slice(startIndex, endIndex);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Agent Balance</p>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Merged Agent Data</h1>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              <Search size={15} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="w-32 bg-transparent outline-none md:w-48"
                placeholder="Search"
              />
            </label>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-all disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-indigo-50 p-2.5 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"><Wallet2 size={16} /></div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Live sync</p>
                <p className="text-sm text-slate-600 dark:text-slate-300">Updated at {lastUpdated || '—'}</p>
              </div>
            </div>
            <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-600 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500" />
              Tracking live
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex min-h-[280px] items-center justify-center rounded-3xl border border-slate-200 bg-white shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
              <Loader2 size={18} className="animate-spin text-indigo-500" />
              <span>Fetching latest data...</span>
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Agent Balance</p>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Merged accounts</h2>
              </div>
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{filteredRows.length} accounts</div>
                <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={currentPage === 1}
                    className="rounded-full px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span>Page {currentPage} of {totalPages}</span>
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-full px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/70">
                  <tr className="border-b border-slate-200 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    {columns.map((col) => <th key={col} className="px-4 py-3 whitespace-nowrap">{col}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    const isExpanded = expandedAgent === row.agentName;
                    return (
                      <Fragment key={row.agentName || i}>
                        <tr
                          onClick={() => setExpandedAgent((current) => current === row.agentName ? null : row.agentName)}
                          className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/70"
                        >
                          <td className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-indigo-600 dark:text-indigo-400">{row.leader}</td>
                          <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-100">
                            <div className="flex items-center gap-2">
                              <span>{row.agentName}</span>
                              <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-700 dark:text-slate-300">{fmtNum(row.openingBal)}</td>
                          <td className="px-4 py-3 font-mono font-semibold text-emerald-600 dark:text-emerald-400">{fmtNum(String(row.agentTotalDP))}</td>
                          <td className="px-4 py-3 font-mono font-semibold text-rose-600 dark:text-rose-400">{fmtNum(String(row.agentTotalWD))}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/50">
                            <td colSpan={5} className="px-4 py-4">
                              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/70">
                                <div className="grid gap-3 sm:grid-cols-3">
                                  <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/80">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">SDP</p>
                                    <p className="mt-1 font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">{fmtNum(row.sdp)}</p>
                                  </div>
                                  <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/80">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Total Top Up</p>
                                    <p className="mt-1 font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">{fmtNum(String(row.totalTopUp))}</p>
                                  </div>
                                  <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/80">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Total STLM</p>
                                    <p className="mt-1 font-mono text-sm font-semibold text-amber-600 dark:text-amber-400">{fmtNum(String(row.totalStlm))}</p>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  }) : <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No matching accounts found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}