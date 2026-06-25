'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Search, CircleDollarSign } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import { rawVal, fmtNum } from '@/app/lib/format';

type TopUpRow = {
  agentName: string;
  toAgent: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
};

export default function TopUpPage() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
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

  const filteredRows = topUpRows.filter((row) => {
    const haystack = `${row.agentName} ${row.toAgent} ${row.wallet} ${row.amount} ${row.date} ${row.type}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white/80 px-4 py-4 backdrop-blur dark:border-[#3a3a3d] dark:bg-[#2a2a2d]/80 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#6b7280] dark:text-[#a0a0a0]">Top Up</p>
            <h1 className="text-2xl font-semibold text-[#1a1a1a] dark:text-white">Top Up Records</h1>
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
              <div className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"><CircleDollarSign size={16} /></div>
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
          <div className="overflow-hidden rounded-xl border border-[#e5e5e7] bg-white shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-between border-b border-[#e5e5e7] px-6 py-4 dark:border-[#3a3a3d]">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Top Up</p>
                <h2 className="text-lg font-semibold text-[#1a1a1a] dark:text-white">Transfer records</h2>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-[#6b7280] dark:bg-slate-800 dark:text-[#a0a0a0]">{filteredRows.length} records</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-[#f5f5f7] dark:bg-slate-800/70">
                  <tr className="border-b border-[#e5e5e7] text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
                    {['Agent Name', 'To Agent', 'Wallet', 'Amount', 'Date', 'Type'].map(col => (
                      <th key={col} className="px-4 py-3 whitespace-nowrap text-[10px]">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                    <tr key={i} className="border-b border-[#e5e5e7] even:bg-[#f5f5f7] hover:bg-[#f5f5f7] dark:border-[#3a3a3d] dark:even:bg-slate-800/40 dark:hover:bg-slate-800/70">
                      <td className="px-4 py-3 text-[10px] font-semibold text-[#1a1a1a] dark:text-white">{row.agentName}</td>
                      <td className="px-4 py-3 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">{row.toAgent}</td>
                      <td className="px-4 py-3 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">{row.wallet}</td>
                      <td className="px-4 py-3 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{fmtNum(row.amount)}</td>
                      <td className="px-4 py-3 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">{row.date}</td>
                      <td className="px-4 py-3 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">{row.type}</td>
                    </tr>
                  )) : <tr><td colSpan={6} className="px-4 py-8 text-center text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">No matching records found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
