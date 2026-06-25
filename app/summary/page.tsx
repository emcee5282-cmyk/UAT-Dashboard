'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Search } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';

type Row = {
  agentName: string;
  openingBal: number;
  sdp: number;
  leader: string;
};

function clean(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  return parseFloat(cleaned) || 0;
}

function fmt(num: number): string {
  if (num === 0) return '—';
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function Summary() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');
      setRows([]);
      const res = await fetch(`/api/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const cols = line.split(',');
          return {
            agentName: cols[0]?.replace(/"/g, '').trim(),
            openingBal: clean(cols[1]),
            sdp: clean(cols[2]),
            leader: cols[3]?.replace(/"/g, '').trim(),
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

  const filteredRows = rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${fmt(row.openingBal)} ${fmt(row.sdp)}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

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

      <main className="space-y-2 p-3">
        {loading && (
          <div className="flex min-h-[160px] items-center justify-center rounded-2xl border border-[#e5e5e7] dark:border-[#3a3a3d]">
            <div className="flex items-center gap-3 text-[#6b7280] dark:text-[#a0a0a0]">
              <Loader2 size={18} className="animate-spin text-indigo-500" />
              <span>Fetching latest data...</span>
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="rounded-xl border border-[#e5e5e7] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-end gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{filteredRows.length} agents</span>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]">
                  <tr className="border-b border-slate-200 dark:border-[#3a3a3d]">
                    {['Leader', 'Agent Name', 'Opening Bal.', 'SDP'].map((col) => (
                      <th key={col} className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.leader}</td>
                      <td className="px-3 py-2 text-center text-[9px] font-bold text-slate-900 dark:text-white">{row.agentName}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmt(row.openingBal)}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmt(row.sdp)}</td>
                    </tr>
                  )) : <tr><td colSpan={4} className="px-3 py-8 text-center text-[9px] text-slate-500 dark:text-slate-400">No matching agents found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}