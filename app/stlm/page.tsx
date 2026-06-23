'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle } from 'lucide-react';

type TopUpRow = {
  agentName: string;
  toAgent: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
};

type StlmRow = {
  agentName: string;
  amount: string;
  remarks: string;
  date: string;
  wallet: string;
  brand: string;
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

export default function StlmTopUp() {
  const [topUpRows, setTopUpRows] = useState<TopUpRow[]>([]);
  const [stlmRows, setStlmRows] = useState<StlmRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);

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
      const stlm: StlmRow[] = [];

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

          const agentRight = rawVal(cols[7]);
          if (agentRight && agentRight !== '-') {
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

      setTopUpRows(topUp);
      setStlmRows(stlm);
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
    const interval = setInterval(fetchData, 600000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="min-h-screen text-slate-100 font-sans">

      <div className="sticky top-0 z-20 bg-[#0b0f1a]/80 backdrop-blur-md border-b border-white/[0.06] px-6 py-3.5 flex items-center justify-between">
        <div className="space-y-0.5">
          <span className="text-[10px] font-semibold tracking-[0.15em] uppercase text-indigo-400">Live Dashboard</span>
          <h1 className="text-sm font-bold text-white">STLM & Top Up</h1>
        </div>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] text-slate-500">Live · {lastUpdated}</span>
            </div>
          )}
          <button
            onClick={fetchData}
            disabled={spinning}
            className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
          >
            <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-8 space-y-7">

        {loading && (
          <div className="flex items-center justify-center py-28 gap-3 text-slate-500">
            <Loader2 size={18} className="animate-spin text-indigo-400" />
            <span className="text-sm">Fetching latest data...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-5 py-4 text-sm">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* TOP UP Table */}
            <div className="bg-[#111827]/60 border border-white/[0.07] rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-4 rounded-full bg-emerald-500/60" />
                  <h2 className="text-sm font-semibold text-slate-200">Top Up</h2>
                </div>
                <span className="text-[11px] text-slate-600 font-mono">{topUpRows.length} records</span>
              </div>
              <div className="overflow-x-auto">
                <div className="min-w-[700px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-[53px] z-10 bg-[#111827]">
                      <tr className="border-b border-white/[0.05]">
                        {['Agent Name', 'To Agent', 'Wallet', 'Amount', 'Date', 'Type'].map(col => (
                          <th key={col} className="px-4 py-3 text-left text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em] whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {topUpRows.map((row, i) => (
                        <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors" />
                              <span className="font-semibold text-slate-200 whitespace-nowrap">{row.agentName}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap">{row.toAgent}</td>
                          <td className="px-4 py-3 text-[12px] text-slate-300 whitespace-nowrap">{row.wallet}</td>
                          <td className="px-4 py-3 font-mono text-[12px] text-emerald-400 whitespace-nowrap tabular-nums">{fmtNum(row.amount)}</td>
                          <td className="px-4 py-3 text-[12px] text-slate-500 whitespace-nowrap">{row.date}</td>
                          <td className="px-4 py-3 text-[12px] text-indigo-300 whitespace-nowrap">{row.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* STLM Table */}
            <div className="bg-[#111827]/60 border border-white/[0.07] rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-4 rounded-full bg-amber-500/60" />
                  <h2 className="text-sm font-semibold text-slate-200">STLM</h2>
                </div>
                <span className="text-[11px] text-slate-600 font-mono">{stlmRows.length} records</span>
              </div>
              <div className="overflow-x-auto">
                <div className="min-w-[700px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-[53px] z-10 bg-[#111827]">
                      <tr className="border-b border-white/[0.05]">
                        {['Agent Name', 'Amount', 'Remarks', 'Date', 'Wallet', 'Brand'].map(col => (
                          <th key={col} className="px-4 py-3 text-left text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em] whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stlmRows.map((row, i) => (
                        <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50 group-hover:bg-amber-400 transition-colors" />
                              <span className="font-semibold text-slate-200 whitespace-nowrap">{row.agentName}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-[12px] text-amber-400 whitespace-nowrap tabular-nums">{fmtNum(row.amount)}</td>
                          <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap">{row.remarks}</td>
                          <td className="px-4 py-3 text-[12px] text-slate-500 whitespace-nowrap">{row.date}</td>
                          <td className="px-4 py-3 text-[12px] text-slate-300 whitespace-nowrap">{row.wallet}</td>
                          <td className="px-4 py-3 text-[12px] text-indigo-300 whitespace-nowrap">{row.brand}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <p className="text-center text-[11px] text-slate-700 pb-2 tracking-wide">
              Powered by AFKenta Solution ®
            </p>
          </>
        )}
      </div>
    </div>
  );
}