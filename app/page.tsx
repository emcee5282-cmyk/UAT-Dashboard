'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Wallet, Activity } from 'lucide-react';
import ThemeToggle from './components/ThemeToggle';
import ConnectionErrorState from './components/ConnectionErrorState';
import TrendChart, { type TrendPoint, type TrendSeriesDef } from './components/TrendChart';
import { classifyFetchError, type ClassifiedError, assertAllOk } from './lib/errors';

const CASHGO_SERIES_DEFS: TrendSeriesDef[] = [
  { key: 'bk', label: 'Bkash' },
  { key: 'ng', label: 'Nagad' },
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// "CashGo" sheet dates are formatted "June 1" (no year).
function parseSheetDate(raw: string): Date | null {
  const match = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = parseInt(match[2], 10);
  return new Date(new Date().getFullYear(), monthIndex, day);
}

type Row = {
  wallet: string;
  totalDP: number;
  totalWD: number;
  bdTransferIn: number;
  stlm: number;
  actualBal: number;
  opening: number;
  runningBal: number;
};

type AgentRow = {
  agentName: string;
  opening: number;
  runningBalance: number;
  totalDP: number;
  balanceInside: number;
};

const RANK_LABELS = ['1st', '2nd', '3rd', '4th'];

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

// Opening sheet col G holds a "REPORT LAST UPDATE" card, e.g. "July 2 - 8:54 AM".
// Top Up totals should only include rows dated on/after this reset point, so
// entries already folded into the last Opening Balance reset aren't double-counted.
function parseReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const cell = (row[6] ?? '').trim();
    const match = cell.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*\d{1,2}:\d{2}\s*[AP]M$/i);
    if (match) {
      const [, monthName, day] = match;
      const year = new Date().getFullYear();
      const parsed = new Date(`${monthName} ${day}, ${year}`);
      if (!isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        return parsed;
      }
    }
  }
  return null;
}

// Stlm Top Up sheet dates are formatted "M/D/YYYY".
function parseStlmRowDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function fmt(num: number): string {
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAbbrev(num: number): string {
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(2)}K`;
  return abs.toFixed(2);
}

function fmtCell(num: number, showSign = false): string {
  if (Math.abs(num) < 0.01) return '—';
  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return showSign && num < 0 ? `-${formatted}` : formatted;
}

type WalletColumnKey = 'wallet' | 'totalDP' | 'totalWD' | 'bdTransferIn' | 'stlm' | 'actualBal' | 'runningBal';

const walletColumns: { key: WalletColumnKey; label: string }[] = [
  { key: 'wallet', label: 'Wallet' },
  { key: 'totalDP', label: 'Total DP' },
  { key: 'totalWD', label: 'Total WD' },
  { key: 'bdTransferIn', label: 'Bundle Transfer' },
  { key: 'stlm', label: 'Settlement' },
  { key: 'actualBal', label: 'Actual Balance' },
  { key: 'runningBal', label: 'Running Balance' },
];

export default function Dashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const searchTerm = '';
  const [openingTotal, setOpeningTotal] = useState(0);
  const [agentRows, setAgentRows] = useState<AgentRow[]>([]);
  const [cashGoWeekData, setCashGoWeekData] = useState<TrendPoint[]>([]);
  const [cashGoMonthData, setCashGoMonthData] = useState<TrendPoint[]>([]);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);
      const [res, openingRes, agentBalRes, stlmRes, cashGoRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/stlm?t=${Date.now()}`),
        fetch(`/api/cashgo?t=${Date.now()}`),
      ]);
      await assertAllOk([res, openingRes, agentBalRes, stlmRes, cashGoRes]);
      const text = await res.text();
      const openingText = await openingRes.text();
      const agentBalText = await agentBalRes.text();
      const stlmText = await stlmRes.text();
      const cashGoText = await cashGoRes.text();
      const lines = text.trim().split('\n').slice(1);
      const parsed: Row[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const cols = line.split(',');
          const totalDP = clean(cols[1]);
          const totalWD = clean(cols[2]);
          const bdTransferIn = clean(cols[3]);
          const stlm = clean(cols[4]);
          const opening = clean(cols[7]);
          return {
            wallet: cols[0]?.replace(/"/g, '').trim(),
            totalDP,
            totalWD,
            bdTransferIn,
            stlm,
            actualBal: clean(cols[5]),
            opening,
            runningBal: opening + totalDP + totalWD + bdTransferIn + stlm,
          };
        });

      const openingSum = openingText
        .trim()
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '')
        .reduce((sum, line) => {
          const raw = line.split(',')[1]?.replace(/"/g, '').trim();
          if (!raw || raw === '-') return sum;
          const value = parseFloat(raw.replace(/,/g, ''));
          if (isNaN(value)) return sum;
          return sum + value;
        }, 0);

      console.log('Total Opening Balance sum:', openingSum);

      const openingRawRows = parseCsvLines(openingText);
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);

      const openingAgentRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: (row[0] ?? '').replace(/"/g, '').trim(),
          openingBal: (row[1] ?? '').replace(/"/g, '').trim(),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      const agentTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      // wallet-type level DP/WD from Balance Limit data — col[4]=walletType, col[11]=DP, col[13]=WD
      const walletDPTotals = new Map<string, number>();
      const walletWDTotals = new Map<string, number>();
      parseCsvLines(agentBalText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const name = (row[1] ?? '').replace(/"/g, '').trim();
          if (!name || name === '-') return;
          const dp = clean(row[11]);
          const wd = clean(row[13]);
          const existing = agentTotals.get(name) ?? { dp: 0, wd: 0 };
          agentTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

          // aggregate by wallet type for the Wallet Summary table
          const wType = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (wType && wType !== '-') {
            walletDPTotals.set(wType, (walletDPTotals.get(wType) ?? 0) + dp);
            walletWDTotals.set(wType, (walletWDTotals.get(wType) ?? 0) + wd);
          }

          const login = (row[15] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (login === 'yes') {
            balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + clean(row[8]));
          }
        });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      const walletTopUpTotals = new Map<string, number>();
      const walletStlmTotals = new Map<string, number>();

      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          // Top Up section (cols A-F = 0-5): col[0]=agent, col[2]=wallet, col[3]=amount, col[4]=date
          const topUpAmountNum = clean((row[3] ?? '').replace(/"/g, '').trim());
          const topUpAgent = (row[0] ?? '').replace(/"/g, '').trim();
          const topUpDate = reportCutoffDate ? parseStlmRowDate((row[4] ?? '').replace(/"/g, '').trim()) : null;
          const topUpInRange = !reportCutoffDate || (topUpDate !== null && topUpDate >= reportCutoffDate);
          if (topUpAgent && topUpAgent !== '-' && topUpAmountNum && topUpInRange) {
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + topUpAmountNum);
          }
          // wallet-level top up — col[2] = wallet brand
          const tuWallet = (row[2] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (tuWallet && tuWallet !== '-' && topUpAmountNum && topUpInRange) {
            walletTopUpTotals.set(tuWallet, (walletTopUpTotals.get(tuWallet) ?? 0) + topUpAmountNum);
          }

          // Settlement section (cols H-M = 7-12): col[7]=agent, col[8]=amount, col[10]=date, col[11]=wallet
          const stlmAgent = (row[7] ?? '').replace(/"/g, '').trim();
          const stlmAmountNum = clean((row[8] ?? '').replace(/"/g, '').trim());
          const stlmDate = reportCutoffDate ? parseStlmRowDate((row[10] ?? '').replace(/"/g, '').trim()) : null;
          const stlmInRange = !reportCutoffDate || (stlmDate !== null && stlmDate >= reportCutoffDate);
          if (stlmAgent && stlmAgent !== '-' && stlmAmountNum && stlmInRange) {
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + stlmAmountNum);
          }
          // wallet-level settlement — col[11] = wallet brand (Bkash/Nagad/etc.)
          const stlmWallet = (row[11] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (stlmWallet && stlmWallet !== '-' && stlmAmountNum && stlmInRange) {
            walletStlmTotals.set(stlmWallet, (walletStlmTotals.get(stlmWallet) ?? 0) + stlmAmountNum);
          }
        });

      // Patch wallet summary rows — all values from Balance Limit / stlm data
      parsed.forEach((row) => {
        const key = row.wallet.toLowerCase();
        const computedDP  = walletDPTotals.get(key) ?? 0;
        const computedWD  = walletWDTotals.get(key) ?? 0;
        const computedTopUp = walletTopUpTotals.get(key) ?? 0;
        const computedStlm  = walletStlmTotals.get(key) ?? 0;
        if (computedDP)  row.totalDP = computedDP;
        if (computedWD)  row.totalWD = -computedWD;   // WD is stored as positive, display as negative
        if (computedTopUp) row.bdTransferIn = computedTopUp;
        if (computedStlm)  row.stlm = -computedStlm;  // Settlement is stored as positive, display as negative
        row.runningBal = row.opening + row.totalDP + row.totalWD + row.bdTransferIn + row.stlm;
      });

      const mergedAgentRows: AgentRow[] = openingAgentRows.map((agent) => {
        const totals = agentTotals.get(agent.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(agent.agentName) ?? 0;
        const totalStlm = stlmTotals.get(agent.agentName) ?? 0;
        const opening = clean(agent.openingBal);
        return {
          agentName: agent.agentName,
          opening,
          runningBalance: opening + totals.dp + totalTopUp - totals.wd - totalStlm,
          totalDP: totals.dp,
          balanceInside: balanceInsideTotals.get(agent.agentName) ?? 0,
        };
      });

      // CashGo Trend — daily Bkash/Nagad amounts, last 7/30 days. The sheet's
      // own quota columns are no longer used (money values only now, no
      // percentage-of-quota concept). Rows with an unparseable date (e.g. the
      // sheet's own blank template rows for future dates) are dropped.
      const cashGoByDate = new Map<string, { bk: number; ng: number }>();
      parseCsvLines(cashGoText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const dateObj = parseSheetDate((row[1] ?? '').replace(/"/g, '').trim());
          if (!dateObj) return;
          cashGoByDate.set(dateObj.toDateString(), { bk: clean(row[4]), ng: clean(row[5]) });
        });

      const toCashGoPoint = (d: Date, isToday: boolean): TrendPoint => {
        const totals = cashGoByDate.get(d.toDateString()) ?? { bk: 0, ng: 0 };
        return {
          day: isToday ? 'Today' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
          tooltipLabel: isToday ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          isToday,
          total: totals.bk + totals.ng,
          series: { bk: totals.bk, ng: totals.ng },
        };
      };

      // Today is always the last bar in the chart itself (highlighted), so
      // each period is N-1 historical days ending yesterday, plus today.
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      const weekHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 5);
      const cashGoWeekPoints: TrendPoint[] = [
        ...Array.from({ length: 6 }, (_, i) =>
          toCashGoPoint(new Date(weekHistoryStart.getFullYear(), weekHistoryStart.getMonth(), weekHistoryStart.getDate() + i), false)
        ),
        toCashGoPoint(now, true),
      ];

      const monthHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 28);
      const cashGoMonthPoints: TrendPoint[] = [
        ...Array.from({ length: 29 }, (_, i) =>
          toCashGoPoint(new Date(monthHistoryStart.getFullYear(), monthHistoryStart.getMonth(), monthHistoryStart.getDate() + i), false)
        ),
        toCashGoPoint(now, true),
      ];

      setRows(parsed);
      setOpeningTotal(openingSum);
      setAgentRows(mergedAgentRows);
      setCashGoWeekData(cashGoWeekPoints);
      setCashGoMonthData(cashGoMonthPoints);
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const dataRows = rows.filter((r) => r.wallet && r.wallet.toLowerCase() !== 'total');
  const totalRow = rows.find((r) => r.wallet.toLowerCase() === 'total');
  const filteredRows = dataRows.filter((row) => {
    const haystack = `${row.wallet} ${row.actualBal} ${row.runningBal} ${row.totalDP} ${row.totalWD}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  // Sum from wallet summary rows (now sourced from Balance Limit data)
  const totalDPSum  = dataRows.reduce((sum, row) => sum + row.totalDP, 0);
  const totalWDSum  = dataRows.reduce((sum, row) => sum + Math.abs(row.totalWD), 0);
  const runningBalTotal = dataRows.reduce((sum, row) => sum + row.runningBal, 0);
  const runningVsOpening = runningBalTotal - openingTotal;

  const top50Agents = agentRows
    .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
    .sort((a, b) => (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
    .slice(0, 50);

  const walletGainRanking = dataRows
    .map((row) => ({ wallet: row.wallet, gain: row.totalDP + row.totalWD, actualBal: row.actualBal }))
    .sort((a, b) => a.gain - b.gain);

  const actualBalTotal = dataRows.reduce((sum, row) => sum + row.actualBal, 0);

  const summaryCards: Array<{
    label: string;
    bigValue: string;
    bigNegative: boolean;
    subAmount: string;
    subSuffix?: string;
    subPositive: boolean;
    showArrow?: boolean;
  }> = totalRow
    ? [
        {
          label: 'Total Deposit',
          bigValue: fmtAbbrev(totalDPSum),
          bigNegative: false,
          subAmount: fmt(totalDPSum),
          subPositive: true,
        },
        {
          label: 'Total Withdrawal',
          bigValue: fmtAbbrev(totalWDSum),
          bigNegative: false,
          subAmount: fmt(totalWDSum),
          subPositive: false,
        },
        {
          label: 'Actual Balance',
          bigValue: fmtAbbrev(actualBalTotal),
          bigNegative: actualBalTotal < 0,
          subAmount: fmt(actualBalTotal),
          subPositive: actualBalTotal >= 0,
        },
        {
          label: 'Running Balance',
          bigValue: fmtAbbrev(runningBalTotal),
          bigNegative: runningBalTotal < 0,
          subAmount: fmt(runningVsOpening),
          subSuffix: 'vs opening',
          subPositive: runningVsOpening >= 0,
          showArrow: true,
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="sticky top-0 z-30 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-indigo-500" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">SSP Cash Out Overview</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 dark:bg-emerald-500/10 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="tabular-nums text-[9px] font-medium text-emerald-700 dark:text-emerald-400">{lastUpdated || '—'}</span>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-500 sm:hidden" />
            <ThemeToggle />
            <button
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

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        {loading && (
          <>
            <div className="relative flex flex-col gap-4 lg:flex-row">
              <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">

                {/* KPI cards skeleton — mirrors: accent bar + icon badge + label + big value + sub */}
                <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-2xl border border-border bg-white p-4 shadow-sm dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="h-2.5 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        <div className="h-7 w-7 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                      </div>
                      <div className="mt-3 h-7 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-2.5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))}
                </section>

                {/* CashGo Trend skeleton — mirrors: icon+title header / today strip+toggles / 360px chart */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-7 w-7 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                      <div className="h-4 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                    <div className="h-7 w-28 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="flex items-center gap-4 border-b border-border px-4 py-2.5">
                    <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="ml-auto flex gap-1.5">
                      <div className="h-6 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="h-6 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  </div>
                  <div className="h-[360px] px-3 py-4">
                    <div className="h-full w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
                  </div>
                </section>

                {/* Wallet Summary skeleton — mirrors: header / right-aligned table / alternating rows */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="border-b border-border px-4 py-3">
                    <div className="h-4 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[700px]">
                      <thead>
                        <tr className="border-b border-border bg-muted/30">
                          {walletColumns.map((col, ci) => (
                            <th key={col.key} className="px-4 py-2.5">
                              <div className={`h-2.5 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 ${ci === 0 ? '' : 'ml-auto'}`} />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: 4 }).map((_, ri) => (
                          <tr key={ri} className={`border-b border-border last:border-0 ${ri % 2 === 1 ? 'bg-muted/10' : ''}`}>
                            <td className="px-4 py-3">
                              <div className="h-3 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                            </td>
                            {walletColumns.slice(1).map((col) => (
                              <td key={col.key} className="px-4 py-3">
                                <div className="ml-auto h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>

              <aside className="flex flex-col gap-4 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[310px]">

                {/* Top Performer Wallet skeleton — mirrors: header+label / circle badge + name/sub + value */}
                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="h-4 w-36 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
                        <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="h-2 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                        <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      </div>
                    ))}
                  </div>
                </section>

                {/* High Volume Agents skeleton — mirrors: header+badge / circle rank + name/inside + balance/diff */}
                <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d] lg:max-h-none lg:min-h-0 lg:flex-1">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <div className="h-4 w-36 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-5 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className={`flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0 ${i < 3 ? 'bg-muted/20' : ''}`}>
                        <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="h-2 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                        <div className="shrink-0 space-y-1.5 text-right">
                          <div className="ml-auto h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          <div className="ml-auto h-2 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && (
          <>
            <div className="relative flex flex-col gap-4 lg:flex-row">
              <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">
                <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {summaryCards.map((card, i) => {
                    const themes = [
                      { Icon: TrendingUp,   iconBg: 'bg-emerald-50 dark:bg-emerald-500/10', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                      { Icon: TrendingDown, iconBg: 'bg-rose-50 dark:bg-rose-500/10',       iconColor: 'text-rose-500 dark:text-rose-400'       },
                      { Icon: Wallet,       iconBg: 'bg-indigo-50 dark:bg-indigo-500/10',   iconColor: 'text-indigo-600 dark:text-indigo-400'   },
                      { Icon: Activity,     iconBg: 'bg-amber-50 dark:bg-amber-500/10',     iconColor: 'text-amber-600 dark:text-amber-400'     },
                    ];
                    const { Icon, iconBg, iconColor } = themes[i] ?? themes[0];
                    return (
                      <div key={card.label} className="rounded-2xl border border-[#e5e5e7] bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{card.label}</span>
                          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
                            <Icon size={13} className={iconColor} />
                          </div>
                        </div>
                        <p className={`mt-2.5 text-[26px] font-bold leading-none tracking-tight ${card.bigNegative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                          {card.bigNegative ? '-' : ''}{card.bigValue}
                        </p>
                        <div className={`mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] font-medium ${card.subPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                          {card.showArrow && <span className="whitespace-nowrap">{card.subPositive ? '▲' : '▼'}</span>}
                          <span className="whitespace-nowrap tabular-nums">{card.subAmount}</span>
                          {card.subSuffix && <span className="whitespace-nowrap font-normal opacity-80">{card.subSuffix}</span>}
                        </div>
                      </div>
                    );
                  })}
                </section>

                <TrendChart title="CashGo Trend" seriesDefs={CASHGO_SERIES_DEFS} weekData={cashGoWeekData} monthData={cashGoMonthData} />

                <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                  <div className="border-b border-border px-4 py-3">
                    <h2 className="text-[13px] font-semibold text-foreground">Wallet Summary</h2>
                  </div>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full min-w-[700px]">
                      <thead>
                        <tr className="border-b border-border bg-muted/30">
                          {walletColumns.map((col) => (
                            <th key={col.key} className="whitespace-nowrap px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:text-left">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.length > 0 ? filteredRows.map((row, i) => (
                          <tr key={row.wallet} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/30 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
                            <td className="whitespace-nowrap px-4 py-3 text-left">
                              <span className="text-[12px] font-bold text-foreground">{row.wallet}</span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                              {fmtCell(row.totalDP)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[11px] font-medium text-rose-600 dark:text-rose-400">
                              {fmtCell(row.totalWD, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[11px] text-foreground">
                              {fmtCell(row.bdTransferIn)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[11px] text-foreground">
                              {fmtCell(row.stlm, true)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[11px] font-medium text-foreground">
                              {fmtCell(row.actualBal)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right">
                              <div className={`tabular-nums text-[11px] font-bold ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                                {fmtCell(row.runningBal, true)}
                              </div>
                              <div className={`mt-0.5 tabular-nums text-[10px] font-medium ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                {row.runningBal >= row.opening ? '▲' : '▼'} {fmtCell(row.runningBal - row.opening)}
                              </div>
                            </td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan={7} className="px-4 py-8 text-center text-[11px] text-muted-foreground">No matching wallets found.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-col gap-3 p-4 sm:hidden">
                    {filteredRows.length > 0 ? filteredRows.map((row) => (
                      <div key={row.wallet} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[15px] font-bold text-foreground">{row.wallet}</span>
                          <div className="text-right">
                            <div className={`text-lg font-bold tabular-nums ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {fmtCell(row.runningBal, true)}
                            </div>
                            <div className={`mt-0.5 text-[11px] font-medium tabular-nums ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {row.runningBal >= row.opening ? '↗' : '↘'} {fmtCell(row.runningBal - row.opening)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total DP</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCell(row.totalDP)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Total WD</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-rose-600 dark:text-rose-400">{fmtCell(row.totalWD, true)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Actual Balance</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.actualBal)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Bundle Transfer</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.bdTransferIn)}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">Settlement</p>
                            <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.stlm, true)}</p>
                          </div>
                        </div>
                      </div>
                    )) : (
                      <div className="px-4 py-8 text-center text-[11px] text-muted-foreground">No matching wallets found.</div>
                    )}
                  </div>
                </section>
              </div>

              <aside className="flex flex-col gap-4 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[310px]">
                <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                    <h2 className="text-[13px] font-semibold text-slate-900 dark:text-white">Top Performer Wallet</h2>
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">Net P&amp;L</span>
                  </div>
                  <div>
                    {walletGainRanking.map((item, index) => {
                      const badgeStyle = ([
                        'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-400',
                        'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
                        'bg-orange-100 text-orange-600 dark:bg-orange-400/20 dark:text-orange-400',
                        'bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                      ] as const)[index] ?? 'bg-slate-50 text-slate-400';
                      return (
                        <div
                          key={item.wallet}
                          className={`flex items-center gap-3 border-b border-[#e5e5e7] px-4 py-2.5 last:border-0 dark:border-[#3a3a3d] ${
                            index === 0 ? 'bg-rose-50/70 dark:bg-rose-500/5' : ''
                          }`}
                        >
                          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${badgeStyle}`}>
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-white">{item.wallet}</p>
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">Bal: {fmtCell(item.actualBal, true)}</p>
                          </div>
                          <span className={`shrink-0 text-[12px] font-bold tabular-nums ${
                            item.gain < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
                          }`}>
                            {fmtCell(item.gain, true)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d] lg:max-h-none lg:min-h-0 lg:flex-1">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="text-[13px] font-semibold text-foreground">High Volume Agents</h2>
                    <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
                      Top {top50Agents.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {top50Agents.length > 0 ? top50Agents.map((agent, index) => {
                      const diff = agent.runningBalance - agent.opening;
                      const up = diff >= 0;
                      const rankBadge = ([
                        'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-400',
                        'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
                        'bg-orange-100 text-orange-600 dark:bg-orange-400/20 dark:text-orange-400',
                      ] as const)[index];
                      return (
                        <div
                          key={agent.agentName}
                          className={`flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0 transition-colors hover:bg-muted/40 ${index < 3 ? 'bg-muted/20' : ''}`}
                        >
                          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${rankBadge ?? 'text-[10px] font-semibold text-muted-foreground'}`}>
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-semibold text-foreground">{agent.agentName}</p>
                            <p className="tabular-nums text-[10px] text-muted-foreground">Inside: {fmtCell(agent.balanceInside)}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={`tabular-nums text-[11px] font-bold ${agent.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {fmtCell(agent.runningBalance, true)}
                            </p>
                            <p className={`tabular-nums text-[10px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {up ? '▲' : '▼'} {fmtCell(diff)}
                            </p>
                          </div>
                        </div>
                      );
                    }) : (
                      <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">No agent data found.</p>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
