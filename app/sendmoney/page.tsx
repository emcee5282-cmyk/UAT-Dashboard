'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Wallet, Activity } from 'lucide-react';
import ThemeToggle from '@/app/components/ThemeToggle';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import TrendChart, { type TrendPoint, type TrendSeriesDef } from '@/app/components/TrendChart';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

const BUNDLE_SERIES_DEFS: TrendSeriesDef[] = [
  { key: 'nagad', label: 'Nagad' },
  { key: 'rocket', label: 'Rocket' },
  { key: 'upay', label: 'UPay' },
];

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

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

// Opening AG col I (index 8) holds Send Money's own "UPDATED TIME" card, e.g.
// "July 4 - 7:03 AM" — same reset-marker pattern as Cashout's own col G.
// Settlement/Top Up totals only include rows dated on/after this point so
// entries already folded into the last Opening Balance reset aren't double-counted.
function parseReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const cell = (row[8] ?? '').trim();
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

// "PS BD STLM + TOPUP" sheet dates are formatted "M/D/YYYY".
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

// Send Money's wallet type is read off the wallet name's own suffix (e.g.
// "N-B4PS2-GYRO023-NG" -> "NG"), same pattern as app/sendmoney/balances —
// every shop's own name already carries its network, confirmed to only ever
// be one of NG/RK/UP/BK. Mapped to the labels used by the "Dashboard
// Overview" sheet's own Send Money block (BKASH/NAGAD/ROCKET/UPAY).
const WALLET_TYPE_LABELS: Record<string, string> = { NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY', BK: 'BKASH' };

function walletTypeLabelFromName(name: string): string | null {
  const segments = name.trim().toUpperCase().split('-');
  const suffix = segments[segments.length - 1];
  return WALLET_TYPE_LABELS[suffix] ?? null;
}

// Settlement isn't shown as its own column here — it reads the same
// underlying source as Bundle Transfer (both "BUNDLE TRANSFER" TYPE rows),
// so displaying both was a duplicate. Bundle Transfer is kept since it
// matches the chart name and the sheet's own TYPE value. Cashout's own
// Wallet Summary (app/page.tsx) is unaffected — Settlement is a genuinely
// distinct value there and keeps both columns.
type WalletColumnKey = 'wallet' | 'totalDP' | 'totalWD' | 'bdTransferIn' | 'actualBal' | 'runningBal';

const walletColumns: { key: WalletColumnKey; label: string }[] = [
  { key: 'wallet', label: 'Wallet' },
  { key: 'totalDP', label: 'Total DP' },
  { key: 'totalWD', label: 'Total WD' },
  { key: 'bdTransferIn', label: 'Bundle Transfer' },
  { key: 'actualBal', label: 'Actual Balance' },
  { key: 'runningBal', label: 'Running Balance' },
];

export default function SendMoneyDashboardPage() {
  const route = getSendMoneyRoute('/sendmoney');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const searchTerm = '';
  const [openingTotal, setOpeningTotal] = useState(0);
  const [agentRows, setAgentRows] = useState<AgentRow[]>([]);
  const [bundleWeekData, setBundleWeekData] = useState<TrendPoint[]>([]);
  const [bundleMonthData, setBundleMonthData] = useState<TrendPoint[]>([]);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);
      const [res, openingRes, balRes, stlmRes] = await Promise.all([
        fetch(`/api/sendmoney/sheet?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
      ]);
      await assertAllOk([res, openingRes, balRes, stlmRes]);
      const text = await res.text();
      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();

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

      const openingRawRows = parseCsvLines(openingText);
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);

      // Send Money's own roster lives in cols L-O (indices 11-14) of the same
      // "Opening AG" sheet Cashout uses for cols A-D.
      const openingSum = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .reduce((sum, line) => {
          const raw = rawVal(line[12]);
          if (!raw || raw === '-') return sum;
          const value = parseFloat(raw.replace(/,/g, ''));
          if (isNaN(value)) return sum;
          return sum + value;
        }, 0);

      const openingAgentRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[11]),
          openingBal: rawVal(row[12]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      const agentTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      // wallet-type level DP/WD from "SSP PS BalanceLimit" — grouped by the
      // wallet name's own suffix (NG/RK/UP/BK), not a Bank/Group text field.
      const walletDPTotals = new Map<string, number>();
      const walletWDTotals = new Map<string, number>();
      balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const name = rawVal(row[0]);
          if (!name || name === '-') return;
          const dp = clean(row[11]);
          const wd = clean(row[13]);
          const existing = agentTotals.get(name) ?? { dp: 0, wd: 0 };
          agentTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

          const typeLabel = walletTypeLabelFromName(name);
          if (typeLabel) {
            walletDPTotals.set(typeLabel, (walletDPTotals.get(typeLabel) ?? 0) + dp);
            walletWDTotals.set(typeLabel, (walletWDTotals.get(typeLabel) ?? 0) + wd);
          }

          const login = rawVal(row[15]).trim().toLowerCase();
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
          // Top Up block (cols B-F = idx 1-5): idx1=wallet name, idx2=amount, idx3=date
          const topUpName = rawVal(row[1]);
          const topUpAmountNum = clean(rawVal(row[2]));
          const topUpDate = reportCutoffDate ? parseStlmRowDate(rawVal(row[3])) : null;
          const topUpInRange = !reportCutoffDate || (topUpDate !== null && topUpDate >= reportCutoffDate);
          if (topUpName && topUpName !== '-' && topUpAmountNum && topUpInRange) {
            topUpTotals.set(topUpName, (topUpTotals.get(topUpName) ?? 0) + topUpAmountNum);
            const typeLabel = walletTypeLabelFromName(topUpName);
            if (typeLabel) walletTopUpTotals.set(typeLabel, (walletTopUpTotals.get(typeLabel) ?? 0) + topUpAmountNum);
          }

          // Settlement block (cols H-L = idx 7-11): idx7=wallet name, idx8=amount, idx9=date
          const stlmName = rawVal(row[7]);
          const stlmAmountNum = clean(rawVal(row[8]));
          const stlmDate = reportCutoffDate ? parseStlmRowDate(rawVal(row[9])) : null;
          const stlmInRange = !reportCutoffDate || (stlmDate !== null && stlmDate >= reportCutoffDate);
          if (stlmName && stlmName !== '-' && stlmAmountNum && stlmInRange) {
            stlmTotals.set(stlmName, (stlmTotals.get(stlmName) ?? 0) + stlmAmountNum);
            const typeLabel = walletTypeLabelFromName(stlmName);
            if (typeLabel) walletStlmTotals.set(typeLabel, (walletStlmTotals.get(typeLabel) ?? 0) + stlmAmountNum);
          }
        });

      // Patch wallet summary rows with computed live totals (Balance Limit +
      // Settlement/Top Up sheet), same as Cashout — the sheet's own seed
      // values (Actual Balance / Opening Balance) are left as-is since those
      // are manually tracked, not derivable from agent-level data.
      parsed.forEach((row) => {
        const key = row.wallet.toUpperCase();
        const computedDP = walletDPTotals.get(key) ?? 0;
        const computedWD = walletWDTotals.get(key) ?? 0;
        const computedTopUp = walletTopUpTotals.get(key) ?? 0;
        const computedStlm = walletStlmTotals.get(key) ?? 0;
        if (computedDP) row.totalDP = computedDP;
        if (computedWD) row.totalWD = -computedWD;
        if (computedTopUp) row.bdTransferIn = computedTopUp;
        if (computedStlm) row.stlm = -computedStlm;
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

      // Bundle Transfer Trend — daily Settlement ("Type" = BUNDLE TRANSFER)
      // totals per wallet, last 7/30 days. Cols H-L (idx 7-11) hold this
      // month's Settlement rows; cols W-AA (idx 22-26) hold last month's
      // archived Settlement rows, same field order shifted +15 — both are
      // unioned since a 30-day window can span the month boundary. Amounts
      // are stored negative in the sheet; displayed as abs().
      const bundleByDate = new Map<string, { NAGAD: number; ROCKET: number; UPAY: number }>();
      const addBundleRow = (nameRaw: string, amountRaw: string, dateRaw: string, walletRaw: string, typeRaw: string) => {
        const type = rawVal(typeRaw).trim().toUpperCase();
        if (type !== 'BUNDLE TRANSFER') return;
        const name = rawVal(nameRaw);
        if (!name || name === '-') return;
        const amount = Math.abs(clean(rawVal(amountRaw)));
        if (!amount) return;
        const date = parseStlmRowDate(rawVal(dateRaw));
        if (!date) return;
        const wallet = rawVal(walletRaw).trim().toUpperCase();
        if (wallet !== 'NAGAD' && wallet !== 'ROCKET' && wallet !== 'UPAY') return;
        const key = date.toDateString();
        const existing = bundleByDate.get(key) ?? { NAGAD: 0, ROCKET: 0, UPAY: 0 };
        existing[wallet as 'NAGAD' | 'ROCKET' | 'UPAY'] += amount;
        bundleByDate.set(key, existing);
      };

      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          addBundleRow(row[7], row[8], row[9], row[10], row[11]); // this month
          addBundleRow(row[22], row[23], row[24], row[25], row[26]); // prev month archive
        });

      const toBundlePoint = (d: Date, isToday: boolean): TrendPoint => {
        const totals = bundleByDate.get(d.toDateString()) ?? { NAGAD: 0, ROCKET: 0, UPAY: 0 };
        return {
          day: isToday ? 'Today' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
          tooltipLabel: isToday ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          isToday,
          total: totals.NAGAD + totals.ROCKET + totals.UPAY,
          series: { nagad: totals.NAGAD, rocket: totals.ROCKET, upay: totals.UPAY },
        };
      };

      // Today is always the last bar in the chart itself (highlighted), so
      // each period is N-1 historical days ending yesterday, plus today.
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      const weekHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 5);
      const weekPoints: TrendPoint[] = [
        ...Array.from({ length: 6 }, (_, i) =>
          toBundlePoint(new Date(weekHistoryStart.getFullYear(), weekHistoryStart.getMonth(), weekHistoryStart.getDate() + i), false)
        ),
        toBundlePoint(now, true),
      ];

      const monthHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 28);
      const monthPoints: TrendPoint[] = [
        ...Array.from({ length: 29 }, (_, i) =>
          toBundlePoint(new Date(monthHistoryStart.getFullYear(), monthHistoryStart.getMonth(), monthHistoryStart.getDate() + i), false)
        ),
        toBundlePoint(now, true),
      ];

      setRows(parsed);
      setOpeningTotal(openingSum);
      setAgentRows(mergedAgentRows);
      setBundleWeekData(weekPoints);
      setBundleMonthData(monthPoints);
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
  const filteredRows = dataRows
    .filter((row) => {
      const haystack = `${row.wallet} ${row.actualBal} ${row.runningBal} ${row.totalDP} ${row.totalWD}`.toLowerCase();
      return haystack.includes(searchTerm.toLowerCase());
    })
    // Bkash isn't integrated yet — always shown last, styled as "Coming Soon".
    .sort((a, b) => Number(a.wallet.toUpperCase() === 'BKASH') - Number(b.wallet.toUpperCase() === 'BKASH'));

  const totalDPSum = dataRows.reduce((sum, row) => sum + row.totalDP, 0);
  const totalWDSum = dataRows.reduce((sum, row) => sum + Math.abs(row.totalWD), 0);
  const runningBalTotal = dataRows.reduce((sum, row) => sum + row.runningBal, 0);
  const runningVsOpening = runningBalTotal - openingTotal;

  const top50Agents = agentRows
    .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
    .sort((a, b) => (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
    .slice(0, 50);

  // Bkash isn't integrated yet — excluded from Top Performer Wallet entirely.
  const walletGainRanking = dataRows
    .filter((row) => row.wallet.toUpperCase() !== 'BKASH')
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
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">{route.title} Overview</h1>
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
          <div className="relative flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">
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

              <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                    <div className="h-4 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                </div>
                <div className="h-[200px] px-3 py-4">
                  <div className="h-full w-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
                </div>
              </section>

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
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && (
          <div className="relative flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {summaryCards.map((card, i) => {
                  const themes = [
                    { Icon: TrendingUp, iconBg: 'bg-emerald-50 dark:bg-emerald-500/10', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                    { Icon: TrendingDown, iconBg: 'bg-rose-50 dark:bg-rose-500/10', iconColor: 'text-rose-500 dark:text-rose-400' },
                    { Icon: Wallet, iconBg: 'bg-[color:var(--product-accent-soft)]', iconColor: 'text-[color:var(--product-accent)]' },
                    { Icon: Activity, iconBg: 'bg-amber-50 dark:bg-amber-500/10', iconColor: 'text-amber-600 dark:text-amber-400' },
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

              <TrendChart title="Bundle Transfer Trend" seriesDefs={BUNDLE_SERIES_DEFS} weekData={bundleWeekData} monthData={bundleMonthData} />

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
                      {filteredRows.length > 0 ? filteredRows.map((row, i) => {
                        const isComingSoon = row.wallet.toUpperCase() === 'BKASH';
                        if (isComingSoon) {
                          return (
                            <tr key={row.wallet} className="border-b border-border last:border-0 bg-muted/5">
                              <td className="whitespace-nowrap px-4 py-3 text-left">
                                <span className="text-[12px] font-bold text-muted-foreground">{row.wallet}</span>
                              </td>
                              <td colSpan={5} className="px-4 py-3 text-center">
                                <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                                  Coming Soon
                                </span>
                              </td>
                            </tr>
                          );
                        }
                        return (
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
                            {fmtCell(row.bdTransferIn, true)}
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
                        );
                      }) : (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-[11px] text-muted-foreground">No matching wallets found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col gap-3 p-4 sm:hidden">
                  {filteredRows.length > 0 ? filteredRows.map((row) => {
                    const isComingSoon = row.wallet.toUpperCase() === 'BKASH';
                    if (isComingSoon) {
                      return (
                        <div key={row.wallet} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/5 p-4">
                          <span className="text-[15px] font-bold text-muted-foreground">{row.wallet}</span>
                          <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                            Coming Soon
                          </span>
                        </div>
                      );
                    }
                    return (
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
                          <p className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-foreground">{fmtCell(row.bdTransferIn, true)}</p>
                        </div>
                      </div>
                    </div>
                    );
                  }) : (
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
                  <span className="rounded-md bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--product-accent)]">
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
        )}
      </main>
    </div>
  );
}
