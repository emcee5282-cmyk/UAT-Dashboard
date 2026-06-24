'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Search, CircleDollarSign } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';

type TopUpRow = {
  agentName: string;
  toAgent: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
};

function rawVal(val: string): string {
  return (val ?? '').replace(/"/g, '').trim() || '-';
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
    <div className="min-h-screen bg-slate-50 text-slate-800 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Top Up</p>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Top Up Records</h1>
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
              <div className="rounded-2xl bg-emerald-50 p-2.5 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"><CircleDollarSign size={16} /></div>
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
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Top Up</p>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Transfer records</h2>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{filteredRows.length} records</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/70">
                  <tr className="border-b border-slate-200 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    {['Agent Name', 'To Agent', 'Wallet', 'Amount', 'Date', 'Type'].map(col => (
                      <th key={col} className="px-4 py-3 whitespace-nowrap">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/70">
                      <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-100">{row.agentName}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.toAgent}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.wallet}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-emerald-600 dark:text-emerald-400">{fmtNum(row.amount)}</td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{row.date}</td>
                      <td className="px-4 py-3 text-indigo-600 dark:text-indigo-400">{row.type}</td>
                    </tr>
                  )) : <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No matching records found.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
