'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, RefreshCw, AlertCircle, Search, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import ThemeToggle from './components/ThemeToggle';

type CashGoPoint = {
  day: string;
  dayName: string;
  bkPct: number;
  ngPct: number;
  totalPct: number;
  bkAmount: number;
  bkQuota: number;
  ngAmount: number;
  ngQuota: number;
  totalAmount: number;
  totalQuota: number;
};

type TodayCashGo = {
  dateLabel: string;
  bkAmount: number;
  bkPct: number;
  ngAmount: number;
  ngPct: number;
  totalAmount: number;
  totalPct: number;
};

function parseQuota(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const match = cleaned.match(/^([\d.]+)\s*([KMkm]?)$/);
  if (!match) return parseFloat(cleaned) || 0;
  const num = parseFloat(match[1]) || 0;
  const suffix = match[2].toUpperCase();
  if (suffix === 'M') return num * 1e6;
  if (suffix === 'K') return num * 1e3;
  return num;
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

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
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

function fmtTooltipAbbrev(num: number): string {
  const abs = Math.abs(num);
  let value = abs;
  let suffix = '';
  if (abs >= 1e9) {
    value = abs / 1e9;
    suffix = 'B';
  } else if (abs >= 1e6) {
    value = abs / 1e6;
    suffix = 'M';
  } else if (abs >= 1e3) {
    value = abs / 1e3;
    suffix = 'K';
  }
  const rounded = Math.round(value * 10) / 10;
  const str = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${str}${suffix}`;
}

function renderTooltipLine(label: string, amount: number, quota: number, boldLabel: boolean) {
  const labelClassName = boldLabel ? 'font-bold text-slate-900 dark:text-white' : 'font-normal text-slate-600 dark:text-slate-300';
  if (quota === 0) {
    return (
      <>
        <span className={labelClassName}>{label}:</span> No Quota
      </>
    );
  }
  return (
    <>
      <span className={labelClassName}>{label}:</span> {fmtTooltipAbbrev(amount)} / {fmtTooltipAbbrev(quota)}
    </>
  );
}

function CashGoTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: CashGoPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const noQuotaAtAll = point.bkQuota === 0 && point.ngQuota === 0;
  return (
    <div className="rounded-lg border border-[#e5e5e7] bg-white px-3 py-2 text-[10px] shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
      <p className="mb-1 font-bold text-slate-900 dark:text-white">{point.dayName}, {point.day}</p>
      {noQuotaAtAll ? (
        <p className="text-slate-600 dark:text-slate-300">No quota assigned for this date</p>
      ) : (
        <>
          <p className="text-slate-600 dark:text-slate-300">{renderTooltipLine('Bkash', point.bkAmount, point.bkQuota, false)}</p>
          <p className="text-slate-600 dark:text-slate-300">{renderTooltipLine('Nagad', point.ngAmount, point.ngQuota, false)}</p>
          <p className="mt-1.5 text-slate-600 dark:text-slate-300">{renderTooltipLine('Total', point.totalAmount, point.totalQuota, true)}</p>
        </>
      )}
    </div>
  );
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
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [openingTotal, setOpeningTotal] = useState(0);
  const [agentRows, setAgentRows] = useState<AgentRow[]>([]);
  const [cashGoWeekData, setCashGoWeekData] = useState<CashGoPoint[]>([]);
  const [cashGoMonthData, setCashGoMonthData] = useState<CashGoPoint[]>([]);
  const [cashGoPeriod, setCashGoPeriod] = useState<'week' | 'month'>('week');
  const [todayCashGo, setTodayCashGo] = useState<TodayCashGo | null>(null);
  const [showBk, setShowBk] = useState(false);
  const [showNg, setShowNg] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');
      setRows([]);
      const [res, openingRes, agentBalRes, stlmRes, cashGoRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/stlm?t=${Date.now()}`),
        fetch(`/api/cashgo?t=${Date.now()}`),
      ]);
      if (!res.ok || !openingRes.ok || !agentBalRes.ok || !stlmRes.ok || !cashGoRes.ok) throw new Error('Failed to fetch');
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

      const openingAgentRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: (row[0] ?? '').replace(/"/g, '').trim(),
          openingBal: (row[1] ?? '').replace(/"/g, '').trim(),
        }))
        .filter((row) => row.agentName && row.agentName !== 'OLD');

      const agentTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      parseCsvLines(agentBalText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const name = (row[1] ?? '').replace(/"/g, '').trim();
          if (!name || name === '-') return;
          const existing = agentTotals.get(name) ?? { dp: 0, wd: 0 };
          agentTotals.set(name, {
            dp: existing.dp + clean(row[11]),
            wd: existing.wd + clean(row[13]),
          });

          const login = (row[15] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (login === 'yes') {
            balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + clean(row[8]));
          }
        });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = (row[0] ?? '').replace(/"/g, '').trim();
          const topUpAmount = (row[3] ?? '').replace(/"/g, '').trim();
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-') {
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + clean(topUpAmount));
          }

          const stlmAgent = (row[7] ?? '').replace(/"/g, '').trim();
          const stlmAmount = (row[8] ?? '').replace(/"/g, '').trim();
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-') {
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + clean(stlmAmount));
          }
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

      const allCashGoRows = parseCsvLines(cashGoText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => {
          const dateRaw = (row[0] ?? '').replace(/"/g, '').trim();
          const bkQuota = parseQuota(row[1]);
          const ngQuota = parseQuota(row[2]);
          const cgBk = clean(row[3]);
          const cgNg = clean(row[4]);
          return { dateRaw, bkQuota, ngQuota, cgBk, cgNg };
        })
        .filter((row) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(row.dateRaw))
        .map((row) => {
          const [month, day, year] = row.dateRaw.split('/').map(Number);
          return { ...row, dateObj: new Date(year, month - 1, day) };
        });

      const now = new Date();
      const isToday = (row: { dateObj: Date }) =>
        row.dateObj.getFullYear() === now.getFullYear() &&
        row.dateObj.getMonth() === now.getMonth() &&
        row.dateObj.getDate() === now.getDate();

      const toPoint = (row: { dateObj: Date; bkQuota: number; ngQuota: number; cgBk: number; cgNg: number }): CashGoPoint => ({
        day: `${String(row.dateObj.getMonth() + 1).padStart(2, '0')}/${String(row.dateObj.getDate()).padStart(2, '0')}`,
        dayName: row.dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
        bkPct: row.bkQuota > 0 ? (row.cgBk / row.bkQuota) * 100 : 0,
        ngPct: row.ngQuota > 0 ? (row.cgNg / row.ngQuota) * 100 : 0,
        totalPct: row.bkQuota + row.ngQuota > 0 ? ((row.cgBk + row.cgNg) / (row.bkQuota + row.ngQuota)) * 100 : 0,
        bkAmount: row.cgBk,
        bkQuota: row.bkQuota,
        ngAmount: row.cgNg,
        ngQuota: row.ngQuota,
        totalAmount: row.cgBk + row.cgNg,
        totalQuota: row.bkQuota + row.ngQuota,
      });

      const validCashGoRows = allCashGoRows.filter((row) => (row.cgBk !== 0 || row.cgNg !== 0) && !isToday(row));

      const cashGoWeekPoints: CashGoPoint[] = validCashGoRows
        .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
        .slice(-7)
        .map(toPoint);

      const cashGoMonthPoints: CashGoPoint[] = allCashGoRows
        .filter((row) => row.dateObj.getFullYear() === now.getFullYear() && row.dateObj.getMonth() === now.getMonth() && !isToday(row))
        .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
        .map(toPoint);

      const todayRow = allCashGoRows.find(isToday);
      const dateLabel = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
      const todaySummary: TodayCashGo | null =
        todayRow && (todayRow.cgBk !== 0 || todayRow.cgNg !== 0)
          ? {
              dateLabel,
              bkAmount: todayRow.cgBk,
              bkPct: todayRow.bkQuota > 0 ? (todayRow.cgBk / todayRow.bkQuota) * 100 : 0,
              ngAmount: todayRow.cgNg,
              ngPct: todayRow.ngQuota > 0 ? (todayRow.cgNg / todayRow.ngQuota) * 100 : 0,
              totalAmount: todayRow.cgBk + todayRow.cgNg,
              totalPct:
                todayRow.bkQuota + todayRow.ngQuota > 0
                  ? ((todayRow.cgBk + todayRow.cgNg) / (todayRow.bkQuota + todayRow.ngQuota)) * 100
                  : 0,
            }
          : null;

      setRows(parsed);
      setOpeningTotal(openingSum);
      setAgentRows(mergedAgentRows);
      setCashGoWeekData(cashGoWeekPoints);
      setCashGoMonthData(cashGoMonthPoints);
      setTodayCashGo(todaySummary);
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

  const dataRows = rows.filter((r) => r.wallet && r.wallet.toLowerCase() !== 'total');
  const totalRow = rows.find((r) => r.wallet.toLowerCase() === 'total');
  const filteredRows = dataRows.filter((row) => {
    const haystack = `${row.wallet} ${row.actualBal} ${row.runningBal} ${row.totalDP} ${row.totalWD}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const runningBalTotal = dataRows.reduce((sum, row) => sum + row.runningBal, 0);
  const runningVsOpening = runningBalTotal - openingTotal;

  const top50Agents = agentRows
    .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
    .sort((a, b) => b.totalDP - a.totalDP || (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
    .slice(0, 50);

  const summaryCards: Array<{
    label: string;
    bigValue: string;
    bigNegative: boolean;
    subArrow: string;
    subAmount: string;
    subSuffix?: string;
    subPositive: boolean;
    icon: typeof Activity;
  }> = totalRow
    ? [
        {
          label: 'Total Deposit',
          bigValue: fmtAbbrev(totalRow.totalDP),
          bigNegative: false,
          subArrow: '↗',
          subAmount: fmt(totalRow.totalDP),
          subPositive: true,
          icon: ArrowUpRight,
        },
        {
          label: 'Total Withdrawal',
          bigValue: fmtAbbrev(totalRow.totalWD),
          bigNegative: false,
          subArrow: '↘',
          subAmount: fmt(totalRow.totalWD),
          subPositive: false,
          icon: ArrowDownRight,
        },
        {
          label: 'Running Balance',
          bigValue: fmtAbbrev(runningBalTotal),
          bigNegative: runningBalTotal < 0,
          subArrow: runningVsOpening >= 0 ? '▲' : '▼',
          subAmount: fmt(runningVsOpening),
          subSuffix: 'vs opening',
          subPositive: runningVsOpening >= 0,
          icon: Activity,
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Cash Out Wallets</h1>
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

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        {loading && (
          <>
            <div className="relative flex flex-col gap-4">
              <div className="flex flex-col gap-4 lg:w-[70%]">
                <section className="grid gap-3 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div key={index} className="rounded-2xl border border-[#e5e5e7] bg-white p-3 shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        <div className="h-3 w-3 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                      </div>
                      <div className="mt-1.5 h-5 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-1.5 h-3 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))}
                </section>

                <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                    <div className="h-4 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-6 w-36 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                    <div className="h-3 w-72 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="flex items-center justify-center gap-4 pt-3">
                    <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                  <div className="h-[320px] px-2 py-4">
                    <div className="h-full w-full animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                </section>
              </div>

              <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d] lg:absolute lg:inset-y-0 lg:right-0 lg:max-h-none lg:w-[28%]">
                <div className="border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                  <div className="h-4 w-40 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-3 px-4 py-2">
                      <div className="h-3 w-5 shrink-0 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        <div className="h-2 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      </div>
                      <div className="shrink-0 space-y-1 text-right">
                        <div className="h-3 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        <div className="h-2 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      {walletColumns.map((col) => (
                        <th key={col.key} className="px-3 py-2">
                          <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 4 }).map((_, rowIndex) => (
                      <tr key={rowIndex}>
                        {walletColumns.map((col) => (
                          <td key={col.key} className="px-3 py-2">
                            <div className="mx-auto h-3 w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="relative flex flex-col gap-4">
              <div className="flex flex-col gap-4 lg:w-[70%]">
                <section className="grid gap-3 sm:grid-cols-3">
                  {summaryCards.map((card) => {
                    const Icon = card.icon;
                    return (
                      <div key={card.label} className="rounded-2xl border border-[#e5e5e7] bg-white p-3 shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-[#6b7280] dark:text-[#a0a0a0]">{card.label}</span>
                          <Icon size={13} className="text-slate-300 dark:text-slate-600" />
                        </div>
                        <p className={`mt-1.5 text-lg font-bold ${card.bigNegative ? 'text-rose-600 dark:text-rose-400' : 'text-[#1a1a1a] dark:text-white'}`}>
                          {card.bigNegative ? '-' : ''}{card.bigValue}
                        </p>
                        <div className={`mt-0.5 flex items-center gap-1 text-[10px] font-medium ${card.subPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          <span>{card.subArrow}</span>
                          <span>{card.subAmount}</span>
                          {card.subSuffix && <span className="font-normal text-[#6b7280] dark:text-[#a0a0a0]">{card.subSuffix}</span>}
                        </div>
                      </div>
                    );
                  })}
                </section>

                <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
                  <div className="flex items-center justify-between border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                    <h2 className="text-[13px] font-semibold text-slate-900 dark:text-white">
                      {cashGoPeriod === 'week' ? '7 — Day CashGo Trend' : `${new Date().toLocaleDateString('en-US', { month: 'long' })} CashGo Trend`}
                    </h2>
                    <div className="flex items-center gap-1 rounded-full bg-slate-100 p-0.5 dark:bg-slate-800">
                      <button
                        onClick={() => setCashGoPeriod('week')}
                        className={`rounded-full px-3 py-1 text-[10px] font-medium transition-colors ${
                          cashGoPeriod === 'week'
                            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        This Week
                      </button>
                      <button
                        onClick={() => setCashGoPeriod('month')}
                        className={`rounded-full px-3 py-1 text-[10px] font-medium transition-colors ${
                          cashGoPeriod === 'month'
                            ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        This Month
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#e5e5e7] px-4 py-3 text-[10px] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
                    <span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                    <span className="font-medium text-slate-700 dark:text-slate-300">Today&apos;s Usage</span>
                    <span className="text-slate-300 dark:text-slate-600">—</span>
                    {todayCashGo ? (
                      <span className="flex flex-wrap items-center gap-x-3">
                        <span>Bkash: {fmtCell(todayCashGo.bkAmount)}</span>
                        <span className="text-slate-300 dark:text-slate-600">|</span>
                        <span>Nagad: {fmtCell(todayCashGo.ngAmount)}</span>
                        <span className="text-slate-300 dark:text-slate-600">|</span>
                        <span className="font-bold text-slate-900 dark:text-white">Total Used: {fmtCell(todayCashGo.totalAmount)}</span>
                      </span>
                    ) : (
                      <span>No data yet for today</span>
                    )}
                  </div>
                  <div className="flex items-center justify-center gap-4 pt-3 text-[10px] text-[#6b7280] dark:text-[#a0a0a0]">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showBk}
                        onChange={(event) => setShowBk(event.target.checked)}
                        className="h-3 w-3 cursor-pointer accent-slate-500"
                      />
                      BK
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showNg}
                        onChange={(event) => setShowNg(event.target.checked)}
                        className="h-3 w-3 cursor-pointer accent-slate-500"
                      />
                      NG
                    </label>
                  </div>
                  <div className="h-[320px] px-2 py-4 outline-none select-none" style={{ outline: 'none', userSelect: 'none' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={cashGoPeriod === 'week' ? cashGoWeekData : cashGoMonthData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="#e5e5e7" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="day"
                          tick={{ fontSize: 10, fill: '#6b7280' }}
                          axisLine={false}
                          tickLine={false}
                          interval={(cashGoPeriod === 'week' ? cashGoWeekData : cashGoMonthData).length > 10 ? 1 : 0}
                        />
                        <YAxis
                          domain={[0, 100]}
                          ticks={[0, 20, 40, 60, 80, 100]}
                          tick={{ fontSize: 10, fill: '#6b7280' }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(value: number) => `${value}%`}
                        />
                        <Tooltip content={<CashGoTooltip />} />
                        <Bar dataKey="totalPct" name="Total Combined %" fill="#1f2937" radius={[3, 3, 0, 0]} activeBar={{ fill: '#0f172a' }} />
                        {showBk && <Bar dataKey="bkPct" name="BK Usage %" fill="#cbd5e1" radius={[3, 3, 0, 0]} activeBar={{ fill: '#334155' }} />}
                        {showNg && <Bar dataKey="ngPct" name="NG Usage %" fill="#d4d4d8" radius={[3, 3, 0, 0]} activeBar={{ fill: '#334155' }} />}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>

              <section className="flex max-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d] lg:absolute lg:inset-y-0 lg:right-0 lg:max-h-none lg:w-[28%]">
                <div className="border-b border-[#e5e5e7] px-4 py-3 dark:border-[#3a3a3d]">
                  <h2 className="text-[13px] font-semibold text-slate-900 dark:text-white">Top {top50Agents.length} High Volume Agents</h2>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {top50Agents.length > 0 ? top50Agents.map((agent, index) => {
                    const diff = agent.runningBalance - agent.opening;
                    const up = diff >= 0;
                    return (
                      <div key={agent.agentName} className="flex items-start gap-3 px-4 py-2">
                        <span className="w-5 shrink-0 text-[9px] font-semibold text-slate-400 dark:text-slate-500">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[10px] font-medium text-slate-900 dark:text-white">{agent.agentName}</p>
                          <p className="text-[8px] text-slate-500 dark:text-slate-400">Bal. Inside: {fmtCell(agent.balanceInside)}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`text-[9px] font-semibold ${agent.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                            {fmtCell(agent.runningBalance, true)}
                          </p>
                          <p className={`text-[8px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {up ? '▲' : '▼'} {fmtCell(diff)}
                          </p>
                        </div>
                      </div>
                    );
                  }) : (
                    <p className="px-4 py-8 text-center text-[11px] text-slate-500 dark:text-slate-400">No agent data found.</p>
                  )}
                </div>
              </section>
            </div>

            <section className="overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white shadow-sm dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      {walletColumns.map((col) => (
                        <th key={col.key} className="whitespace-nowrap px-3 py-2 text-center text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length > 0 ? filteredRows.map((row) => (
                      <tr key={row.wallet} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-3 py-2 text-center text-[9px] font-bold text-slate-900 dark:text-white">{row.wallet}</td>
                        <td className="px-3 py-2 text-center text-[9px] text-emerald-600 dark:text-emerald-400">{fmtCell(row.totalDP)}</td>
                        <td className="px-3 py-2 text-center text-[9px] text-rose-600 dark:text-rose-400">{fmtCell(row.totalWD, true)}</td>
                        <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmtCell(row.bdTransferIn)}</td>
                        <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmtCell(row.stlm, true)}</td>
                        <td className="px-3 py-2 text-center text-[9px] text-slate-700 dark:text-slate-300">{fmtCell(row.actualBal)}</td>
                        <td className="px-3 py-2 text-center">
                          <div className={`text-[9px] font-semibold ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>{fmtCell(row.runningBal, true)}</div>
                          <div className={`mt-0.5 text-[8px] font-medium ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {row.runningBal >= row.opening ? '▲' : '▼'} {fmtCell(row.runningBal - row.opening)}
                          </div>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No matching wallets found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
