'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { parseSendMoneyOpeningCsv, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';

function fmtAbbrev(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtFull(num: number): string {
  return num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const kpiValueClass = 'text-[28px] font-medium text-foreground mb-1 tabular-nums';
const kpiSkeleton = <div className="h-8 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 mb-1" />;

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<SendMoneyOpeningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [noOpeningFilterActive, setNoOpeningFilterActive] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setError('');
      const res = await fetch(`/api/sendmoney/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const text = await res.text();
      setRows(parseSendMoneyOpeningCsv(text));
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
    } finally {
      // Only ever flips loading off — the KPI skeleton is a first-load-only
      // thing; refreshes keep showing the previous numbers until new ones land.
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const accounts = rows.length;
  const totalOpening = useMemo(() => rows.reduce((sum, r) => sum + (r.openingBalance ?? 0), 0), [rows]);
  const totalSdp = useMemo(() => rows.reduce((sum, r) => sum + (r.securityDeposit ?? 0), 0), [rows]);
  const noOpeningCount = useMemo(() => rows.filter((r) => r.openingBalance === null).length, [rows]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[5px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Opening Balance</h1>
            <span className="rounded-full bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[color:var(--product-accent)]">
              Send Money
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 dark:bg-emerald-500/10 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="tabular-nums text-[9px] font-medium text-emerald-700 dark:text-emerald-400">{lastUpdated || '—'}</span>
            </div>
            <button
              type="button"
              onClick={fetchData}
              disabled={spinning}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            {error}
          </div>
        )}

        {!error && (
          <div className="flex gap-4 mb-6">
            <div className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]">
              <p className="text-xs text-muted-foreground font-medium mb-1">Accounts</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{accounts.toLocaleString('en-PH')}</p>}
            </div>

            <div
              className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]"
              title={loading ? undefined : fmtFull(totalOpening)}
            >
              <p className="text-xs text-muted-foreground font-medium mb-1">Total Opening Balance</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{fmtAbbrev(totalOpening)}</p>}
            </div>

            <div
              className="bg-white rounded-xl border border-border p-5 flex-1 min-w-0 dark:bg-[#2a2a2d]"
              title={loading ? undefined : fmtFull(totalSdp)}
            >
              <p className="text-xs text-muted-foreground font-medium mb-1">Total Security Deposit</p>
              {loading ? kpiSkeleton : <p className={kpiValueClass}>{fmtAbbrev(totalSdp)}</p>}
            </div>

            <button
              type="button"
              aria-pressed={noOpeningFilterActive}
              onClick={() => setNoOpeningFilterActive((current) => !current)}
              className={`text-left rounded-xl border p-5 flex-1 min-w-0 transition-colors ${
                noOpeningFilterActive
                  ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-active-bg)]'
                  : 'border-[color:var(--product-accent)]/30 bg-[color:var(--product-accent-soft)] hover:bg-[color:var(--product-accent-active-bg)]'
              }`}
            >
              <p className="text-xs font-medium mb-1 text-[color:var(--product-accent)]">No Opening Yet</p>
              {loading ? kpiSkeleton : <p className={`${kpiValueClass} text-[color:var(--product-accent)]`}>{noOpeningCount.toLocaleString('en-PH')}</p>}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
