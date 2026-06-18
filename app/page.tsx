'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, RefreshCw, Loader2, AlertCircle, TrendingUp, TrendingDown, Wallet, Zap } from 'lucide-react';

type Row = {
  wallet: string;
  totalDP: number;
  totalWD: number;
  bdTransferIn: number;
  stlm: number;
  actualBal: number;
  runningBal: number;
};

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

function fmt(num: number, isCurrency = true): string {
  if (!isCurrency) return num.toLocaleString();
  const abs = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return abs;
}

function numColor(num: number): string {
  if (num < 0) return 'text-red-400';
  if (num > 0) return 'text-slate-100';
  return 'text-slate-500';
}

export default function Dashboard() {
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
      const res = await fetch(`/api/sheet?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const cols = line.split(',');
          return {
            wallet: cols[0]?.replace(/"/g, '').trim(),
            totalDP: clean(cols[1]),
            totalWD: clean(cols[2]),
            bdTransferIn: clean(cols[3]),
            stlm: clean(cols[4]),
            actualBal: clean(cols[5]),
            runningBal: clean(cols[6]),
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

  const dataRows = rows.filter((r) => r.wallet.toLowerCase() !== 'total');
  const totalRow = rows.find((r) => r.wallet.toLowerCase() === 'total');

  const columns = [
    { label: 'Wallet', key: 'wallet', currency: false },
    { label: 'Total DP', key: 'totalDP', currency: true },
    { label: 'Total WD', key: 'totalWD', currency: true },
    { label: 'BD-Transfer IN', key: 'bdTransferIn', currency: true },
    { label: 'STLM', key: 'stlm', currency: true },
    { label: 'Actual Bal.', key: 'actualBal', currency: true },
    { label: 'Running Bal.', key: 'runningBal', currency: true },
  ];

  const kpis = totalRow
    ? [
        { label: 'Total Deposits', value: fmt(totalRow.totalDP), icon: TrendingUp, accent: '#22d3ee', glow: 'shadow-[0_0_24px_0_rgba(34,211,238,0.15)]', tag: 'DP' },
        { label: 'Total Withdrawals', value: fmt(totalRow.totalWD), icon: TrendingDown, accent: '#f87171', glow: 'shadow-[0_0_24px_0_rgba(248,113,113,0.15)]', tag: 'WD' },
        { label: 'Actual Balance', value: fmt(totalRow.actualBal), icon: Wallet, accent: '#a78bfa', glow: 'shadow-[0_0_24px_0_rgba(167,139,250,0.15)]', tag: 'BAL' },
        { label: 'Running Balance', value: fmt(totalRow.runningBal), icon: Activity, accent: '#34d399', glow: 'shadow-[0_0_24px_0_rgba(52,211,153,0.15)]', tag: 'RUN' },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 font-sans">

      <div className="fixed top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      <header className="sticky top-0 z-20 bg-[#0b0f1a]/80 backdrop-blur-md border-b border-white/[0.06] px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
            <Zap size={14} className="text-indigo-400" />
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div>
            <p className="font-bold text-sm tracking-tight text-white leading-none">Operations Overview</p>
          </div>
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
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-7">

        <div className="space-y-1">
          <span className="text-[10px] font-semibold tracking-[0.15em] uppercase text-indigo-400">Live Dashboard</span>
          <h1 className="text-2xl font-bold text-white tracking-tight">Smart Solution — Cash Out</h1>
          <p className="text-[12px] text-slate-500">Summary</p>
        </div>

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
            {kpis.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {kpis.map((kpi) => {
                  const Icon = kpi.icon;
                  return (
                    <div key={kpi.label} className={`relative bg-[#111827]/80 border border-white/[0.07] rounded-2xl p-5 overflow-hidden hover:border-white/[0.12] transition-all ${kpi.glow}`}>
                      <div className="absolute top-0 left-0 right-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${kpi.accent}55, transparent)` }} />
                      <div className="flex items-start justify-between mb-4">
                        <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-slate-500">{kpi.label}</span>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${kpi.accent}18`, border: `1px solid ${kpi.accent}30` }}>
                          <Icon size={13} style={{ color: kpi.accent }} />
                        </div>
                      </div>
                      <p className="text-xl font-bold font-mono tracking-tight" style={{ color: kpi.accent }}>{kpi.value}</p>
                      <span className="mt-2 inline-block text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded" style={{ background: `${kpi.accent}18`, color: kpi.accent }}>{kpi.tag}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="bg-[#111827]/60 border border-white/[0.07] rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-4 rounded-full bg-indigo-500/60" />
                  <h2 className="text-sm font-semibold text-slate-200">Wallet Breakdown</h2>
                </div>
                <span className="text-[11px] text-slate-600 font-mono">{dataRows.length} wallets</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.05]">
                      {columns.map((col) => (
                        <th key={col.key} className="px-5 py-3 text-left text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em] whitespace-nowrap">
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataRows.map((row) => (
                      <tr key={row.wallet} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/50 group-hover:bg-indigo-400 transition-colors" />
                            <span className="font-semibold text-slate-200 whitespace-nowrap">{row.wallet}</span>
                          </div>
                        </td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.totalDP)}`}>{fmt(row.totalDP)}</td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.totalWD)}`}>{fmt(row.totalWD)}</td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.bdTransferIn)}`}>{fmt(row.bdTransferIn)}</td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.stlm)}`}>{fmt(row.stlm)}</td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.actualBal)}`}>{fmt(row.actualBal)}</td>
                        <td className={`px-5 py-3.5 font-mono text-[13px] whitespace-nowrap tabular-nums ${numColor(row.runningBal)}`}>{fmt(row.runningBal)}</td>
                      </tr>
                    ))}
                    {totalRow && (
                      <tr className="bg-indigo-500/[0.08] border-t border-indigo-500/20">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                            <span className="font-bold text-indigo-300 whitespace-nowrap tracking-wide text-[13px] uppercase">Total</span>
                          </div>
                        </td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.totalDP)}`}>{fmt(totalRow.totalDP)}</td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.totalWD)}`}>{fmt(totalRow.totalWD)}</td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.bdTransferIn)}`}>{fmt(totalRow.bdTransferIn)}</td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.stlm)}`}>{fmt(totalRow.stlm)}</td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.actualBal)}`}>{fmt(totalRow.actualBal)}</td>
                        <td className={`px-5 py-4 font-mono font-bold text-[13px] whitespace-nowrap tabular-nums ${numColor(totalRow.runningBal)}`}>{fmt(totalRow.runningBal)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-center text-[11px] text-slate-700 pb-2 tracking-wide">
              Powered by Smart Solution ®
            </p>
          </>
        )}
      </main>
    </div>
  );
}