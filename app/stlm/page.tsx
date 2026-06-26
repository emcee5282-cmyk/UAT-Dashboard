'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, AlertCircle, Search, Loader2 } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import { rawVal, displayNum } from '@/app/lib/format';

type StlmRow = {
  agentName: string;
  amount: string;
  remarks: string;
  date: string;
  wallet: string;
  brand: string;
};

function mapBrand(value: string): string {
  const v = value.toUpperCase().trim();
  if (v.includes('MCW')) return 'M1';
  if (v.includes('MXW')) return 'M2';
  if (v.includes('BB')) return 'B1';
  if (v.includes('BGB')) return 'B2';
  if (v.includes('BS')) return 'B3';
  if (v.includes('BW')) return 'B4';
  if (v.includes('BP')) return 'B5';
  if (v.includes('KLG')) return 'K1';
  if (v.includes('JY')) return 'J1';
  if (v.includes('TK')) return 'T1';
  return value || '−';
}

export default function StlmPage() {
  const [stlmRows, setStlmRows] = useState<StlmRow[]>([]);
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

      const stlm: StlmRow[] = [];

      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const agentRight = rawVal(cols[7]);
          if (agentRight && agentRight !== '-' && agentRight !== '0') {
            stlm.push({
              agentName: agentRight,
              amount: rawVal(cols[8]),
              remarks: rawVal(cols[9]),
              date: rawVal(cols[10]),
              wallet: rawVal(cols[11]),
              brand: rawVal(cols[12]),
            });
          }
        });

      setStlmRows(stlm.filter(row => row.agentName && row.agentName !== '-' && row.agentName !== '0'));
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

  const filteredRows = stlmRows.filter((row) => {
    const haystack = `${row.agentName} ${row.amount} ${row.remarks} ${row.date} ${row.wallet} ${row.brand}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Settlement</h1>
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
            <div className="flex items-center justify-end gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{filteredRows.length} records</span>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]">
                  <tr className="border-b border-slate-200 dark:border-[#3a3a3d]">
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Brand</th>
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Agent Name</th>
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Wallet</th>
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Amount</th>
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Remarks</th>
                    <th className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                    <tr key={i} className="bg-white dark:bg-[#2a2a2d]">
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{mapBrand(row.brand)}</td>
                      <td className="px-3 py-2 text-center text-[9px] font-bold text-slate-900 dark:text-white">{row.agentName}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.wallet}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.amount)}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.remarks}</td>
                      <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.date}</td>
                    </tr>
                  )) : !loading && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-[10px] text-slate-400 dark:text-slate-500">
                        No matching records found.
                      </td>
                    </tr>
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