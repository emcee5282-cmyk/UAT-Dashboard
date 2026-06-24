'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, RefreshCw, Loader2, AlertCircle, TrendingUp, TrendingDown, Wallet2, Search, ArrowUpRight, Sparkles, ChevronRight, BarChart3 } from 'lucide-react';
import ThemeToggle from './components/ThemeToggle';

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

function fmt(num: number): string {
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function numColor(num: number): string {
  if (num < 0) return 'text-red-500';
  if (num > 0) return 'text-emerald-600';
  return 'text-slate-400';
}

export default function Dashboard() {
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
  }, [fetchData]);

  const dataRows = rows.filter((r) => r.wallet.toLowerCase() !== 'total');
  const totalRow = rows.find((r) => r.wallet.toLowerCase() === 'total');
  const filteredRows = dataRows.filter((row) => {
    const haystack = `${row.wallet} ${row.actualBal} ${row.runningBal} ${row.totalDP} ${row.totalWD}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const kpis = totalRow
    ? [
        { label: 'Total Deposits', value: fmt(totalRow.totalDP), icon: TrendingUp, accent: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-500/10', tag: '+12.4%' },
        { label: 'Total Withdrawals', value: fmt(totalRow.totalWD), icon: TrendingDown, accent: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-500/10', tag: '-3.2%' },
        { label: 'Actual Balance', value: fmt(totalRow.actualBal), icon: Wallet2, accent: 'text-indigo-600', bg: 'bg-indigo-50 dark:bg-indigo-500/10', tag: '+8.1%' },
        { label: 'Running Balance', value: fmt(totalRow.runningBal), icon: Activity, accent: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10', tag: '+5.2%' },
      ]
    : [];

  const chartPoints = [34, 48, 41, 62, 56, 74, 69];
  const linePath = chartPoints.map((value, index) => `${index === 0 ? 'M' : 'L'} ${index * 48 + 12} ${150 - value}`).join(' ');
  const benchmarkPath = 'M 12 122 L 60 110 L 108 116 L 156 98 L 204 104 L 252 86 L 300 82';

  const movers = [...filteredRows].sort((a, b) => b.actualBal - a.actualBal).slice(0, 5);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Operations Overview</p>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Cash Out Wallets</h1>
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
            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2.5 py-2 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300">A</div>
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Admin</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Operations</p>
              </div>
            </div>
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Live sync</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">Updated at {lastUpdated || '—'}</p>
          </div>
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-600 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400">
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500" />
            Tracking live
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
          <>
            <section className="grid gap-4 xl:grid-cols-4">
              {kpis.map((kpi) => {
                const Icon = kpi.icon;
                return (
                  <div key={kpi.label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">{kpi.label}</span>
                      <div className={`rounded-2xl p-2 ${kpi.bg}`}>
                        <Icon size={15} className={kpi.accent} />
                      </div>
                    </div>
                    <div className="flex items-end justify-between">
                      <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{kpi.value}</p>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{kpi.tag}</span>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-6 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Performance</p>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Balance trend</h2>
                  </div>
                  <div className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 dark:border-indigo-800/70 dark:bg-indigo-500/10 dark:text-indigo-300">Benchmark +7.3%</div>
                </div>
                <div className="rounded-3xl bg-slate-50 p-4 dark:bg-slate-800/70">
                  <svg viewBox="0 0 320 160" className="h-48 w-full">
                    <line x1="12" y1="140" x2="308" y2="140" stroke="#dbe2ea" strokeWidth="1" />
                    <line x1="12" y1="100" x2="308" y2="100" stroke="#dbe2ea" strokeWidth="1" />
                    <line x1="12" y1="60" x2="308" y2="60" stroke="#dbe2ea" strokeWidth="1" />
                    <path d={linePath} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinecap="round" />
                    <path d={benchmarkPath} fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 6" />
                    {chartPoints.map((value, index) => (
                      <circle key={index} cx={index * 48 + 12} cy={150 - value} r="4" fill="#4f46e5" />
                    ))}
                  </svg>
                  <div className="mt-4 flex items-center gap-5 text-sm text-slate-500 dark:text-slate-400">
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-600" />Portfolio</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" />Benchmark</div>
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-6 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Holdings</p>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Wallet breakdown</h2>
                  </div>
                  <button className="text-sm font-medium text-indigo-600 dark:text-indigo-400">View all</button>
                </div>
                <div className="space-y-3">
                  {filteredRows.length > 0 ? filteredRows.slice(0, 5).map((row) => {
                    const weight = totalRow ? ((row.actualBal / totalRow.actualBal) * 100) : 0;
                    return (
                      <div key={row.wallet} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-slate-100">{row.wallet}</p>
                          <p className="text-sm text-slate-500 dark:text-slate-400">{weight.toFixed(1)}% weight</p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-slate-900 dark:text-slate-100">{fmt(row.actualBal)}</p>
                          <p className={`text-sm ${numColor(row.actualBal)}`}>{row.runningBal >= 0 ? '+' : ''}{fmt(row.runningBal)}</p>
                        </div>
                      </div>
                    );
                  }) : <div className="rounded-2xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">No matching wallets found.</div>}
                </div>
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-[0.9fr_0.7fr_0.8fr]">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Summary</p>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Allocation mix</h2>
                  </div>
                  <Sparkles size={16} className="text-indigo-500" />
                </div>
                <div className="flex items-center gap-4">
                  <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-[conic-gradient(#4f46e5_0_68%,#e2e8f0_68%_100%)] dark:bg-[conic-gradient(#818cf8_0_68%,#334155_68%_100%)]">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-700 dark:bg-slate-950 dark:text-slate-100">68%</div>
                  </div>
                  <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-600" />Balanced funds</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-slate-300" />Reserve cash</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />Operational margin</div>
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Top movers</p>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">High impact wallets</h2>
                  </div>
                  <BarChart3 size={16} className="text-emerald-500" />
                </div>
                <div className="space-y-3">
                  {movers.length > 0 ? movers.map((row) => (
                    <div key={row.wallet} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm dark:border-slate-700 dark:bg-slate-800/70">
                      <div>
                        <p className="font-semibold text-slate-800 dark:text-slate-100">{row.wallet}</p>
                        <p className="text-slate-500 dark:text-slate-400">{fmt(row.actualBal)}</p>
                      </div>
                      <div className="flex items-center gap-1 font-semibold text-emerald-600">
                        <ArrowUpRight size={14} />
                        {fmt(row.runningBal)}
                      </div>
                    </div>
                  )) : <div className="rounded-2xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">No matching movers found.</div>}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_60px_-30px_rgba(15,23,42,0.35)] dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Activity</p>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Latest updates</h2>
                  </div>
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
                <div className="space-y-3">
                  {[
                    ['Balance synced', 'Wallets refreshed from the source sheet'],
                    ['Settlement posted', 'STLM values updated for the latest cycle'],
                    ['Top up reviewed', 'Pending top-up records verified'],
                  ].map(([title, desc]) => (
                    <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                      <p className="font-semibold text-slate-800 dark:text-slate-100">{title}</p>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}