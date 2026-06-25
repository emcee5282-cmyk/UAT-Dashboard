'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Search, BookOpen } from 'lucide-react';
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
  if (num === 0) return '-';
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
      <header className="border-b border-[#e5e5e7] bg-white/80 px-4 py-4 backdrop-blur dark:border-[#3a3a3d] dark:bg-[#2a2a2d]/80 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#6b7280] dark:text-[#a0a0a0]">Agent Summary</p>
            <h1 className="text-2xl font-semibold text-[#1a1a1a] dark:text-white">Opening Balance</h1>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] bg-[#f5f5f7] px-3 py-2 text-sm text-[#6b7280] dark:border-[#3a3a3d] dark:bg-slate-800 dark:text-[#a0a0a0]">
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
              className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] bg-white px-3 py-2 text-sm font-medium text-[#6b7280] shadow-sm transition-all disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-slate-800 dark:text-[#a0a0a0]"
            >
              <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        <div className="rounded-2xl border border-[#e5e5e7] bg-white p-5 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"><BookOpen size={16} /></div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Live sync</p>
                <p className="text-sm text-[#6b7280] dark:text-[#a0a0a0]">Updated at {lastUpdated || '—'}</p>
              </div>
            </div>
            <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-600 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500" />
              Tracking live
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex min-h-[280px] items-center justify-center rounded-2xl border border-[#e5e5e7] bg-white shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center gap-3 text-[#6b7280] dark:text-[#a0a0a0]">
              <Loader2 size={18} className="animate-spin text-indigo-500" />
              <span>Fetching latest data...</span>
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="rounded-xl border border-[#e5e5e7] bg-white p-0 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-between border-b border-[#e5e5e7] px-6 py-4 dark:border-[#3a3a3d]">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Agent List</p>
                <h2 className="text-lg font-semibold text-[#1a1a1a] dark:text-white">Opening Balance</h2>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-[#6b7280] dark:bg-slate-800 dark:text-[#a0a0a0]">{filteredRows.length} agents</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#f5f5f7] dark:bg-slate-800/70">
                  <tr className="border-b border-[#e5e5e7] text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
                    {['Leader', 'Agent Name', 'Opening Bal.', 'SDP'].map((col) => (
                      <th key={col} className="px-5 py-3 whitespace-nowrap text-[10px]">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                    <tr key={i} className="border-b border-[#e5e5e7] hover:bg-[#f5f5f7] dark:border-[#3a3a3d] dark:hover:bg-slate-800/70">
                      <td className="px-5 py-3.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-indigo-600 dark:text-indigo-400">{row.leader}</td>
                      <td className="px-5 py-3.5 text-[10px] font-semibold text-[#1a1a1a] dark:text-white">{row.agentName}</td>
                      <td className="px-5 py-3.5 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">{fmt(row.openingBal)}</td>
                      <td className="px-5 py-3.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{fmt(row.sdp)}</td>
                    </tr>
                  )) : <tr><td colSpan={4} className="px-5 py-8 text-center text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">No matching agents found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}