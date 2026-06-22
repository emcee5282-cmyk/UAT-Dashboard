'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle } from 'lucide-react';

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
    const interval = setInterval(fetchData, 600000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="min-h-screen text-slate-100 font-sans">

      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-[#0b0f1a]/80 backdrop-blur-md border-b border-white/[0.06] px-6 py-3.5 flex items-center justify-between">
        <div className="space-y-0.5">
          <span className="text-[10px] font-semibold tracking-[0.15em] uppercase text-indigo-400">Agent Summary</span>
          <h1 className="text-sm font-bold text-white">Opening Balance</h1>
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
          <div className="bg-[#111827]/60 border border-white/[0.07] rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-4 rounded-full bg-indigo-500/60" />
                <h2 className="text-sm font-semibold text-slate-200">Agent List</h2>
              </div>
              <span className="text-[11px] text-slate-600 font-mono">{rows.length} agents</span>
            </div>
            <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-200px)]">
              <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-[#111827]">
                    <tr className="border-b border-white/[0.05]">
                    {['Leader', 'Agent Name', 'Opening Bal.', 'SDP'].map((col) => (
                      <th key={col} className="px-5 py-3 text-left text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em] whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group">
                      <td className="px-5 py-3.5">
                        <span className="text-[11px] font-bold tracking-widest text-indigo-300 uppercase">{row.leader}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/50 group-hover:bg-indigo-400 transition-colors" />
                          <span className="font-semibold text-slate-200 whitespace-nowrap">{row.agentName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-[13px] tabular-nums text-slate-100 whitespace-nowrap">
                        {fmt(row.openingBal)}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-[13px] tabular-nums text-emerald-400 whitespace-nowrap">
                        {fmt(row.sdp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-slate-700 pb-2 tracking-wide">
          Powered by AFKenta Solution ®
        </p>
      </div>
    </div>
  );
}