'use client';

// Full recreation of app/page.tsx (Cash Out Overview), restyled with shadcn
// components (Card/Table/Badge/Skeleton) instead of the hand-rolled Design
// System v2 markup. Same data, same computations, same labels/copy as the
// real page — duplicated here rather than shared, same convention the rest
// of this codebase already uses for page-local logic. CashGo Trend uses
// CashGoTrendShadcn (../CashGoTrendShadcn.tsx) — a from-scratch shadcn
// recreation (Card/Button/Chart primitives), still a stacked bar chart,
// built alongside rather than by editing app/components/TrendChart.tsx.
// Scratch/demo route only — not linked in the sidebar, does not touch
// app/page.tsx or app/components/TrendChart.tsx.

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Wallet, Activity } from 'lucide-react';
import ThemeToggle from '../../components/ThemeToggle';
import ConnectionErrorState from '../../components/ConnectionErrorState';
import { type TrendPoint, type TrendSeriesDef } from '../../components/TrendChart';
import CashGoTrendShadcn from '../CashGoTrendShadcn';
import { getBusinessToday } from '../../lib/businessDate';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../../lib/errors';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/* ------------------------------------------------------------------ */
/* Data layer — copied verbatim from app/page.tsx. No logic changes;   */
/* only the render layer below is different.                           */
/* ------------------------------------------------------------------ */

const CASHGO_SERIES_DEFS: TrendSeriesDef[] = [
  { key: 'bk', label: 'Bkash' },
  { key: 'ng', label: 'Nagad' },
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

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

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

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

/* ------------------------------------------------------------------ */
/* Render layer — shadcn components (Card/Table/Badge/Skeleton) instead */
/* of app/page.tsx's own hand-rolled markup. Same copy/labels/data.     */
/* ------------------------------------------------------------------ */

export default function ShadcnCashOutOverviewDemo() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
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
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
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

      const openingRawRows = parseCsvLines(openingText);
      const reportCutoffDate = getBusinessToday();

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
          const topUpAmountNum = clean((row[2] ?? '').replace(/"/g, '').trim());
          const topUpAgent = stripBrandSuffix((row[1] ?? '').replace(/"/g, '').trim());
          const topUpDate = reportCutoffDate ? parseStlmRowDate((row[3] ?? '').replace(/"/g, '').trim()) : null;
          const topUpInRange = !reportCutoffDate || (topUpDate !== null && topUpDate >= reportCutoffDate);
          if (topUpAgent && topUpAgent !== '-' && topUpAmountNum && topUpInRange) {
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + topUpAmountNum);
          }
          const tuWallet = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (tuWallet && tuWallet !== '-' && topUpAmountNum && topUpInRange) {
            walletTopUpTotals.set(tuWallet, (walletTopUpTotals.get(tuWallet) ?? 0) + topUpAmountNum);
          }

          const stlmAgent = stripBrandSuffix((row[7] ?? '').replace(/"/g, '').trim());
          const stlmAmountNum = Math.abs(clean((row[8] ?? '').replace(/"/g, '').trim()));
          const stlmDate = reportCutoffDate ? parseStlmRowDate((row[9] ?? '').replace(/"/g, '').trim()) : null;
          const stlmInRange = !reportCutoffDate || (stlmDate !== null && stlmDate >= reportCutoffDate);
          if (stlmAgent && stlmAgent !== '-' && stlmAmountNum && stlmInRange) {
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + stlmAmountNum);
          }
          const stlmWallet = (row[10] ?? '').replace(/"/g, '').trim().toLowerCase();
          if (stlmWallet && stlmWallet !== '-' && stlmAmountNum && stlmInRange) {
            walletStlmTotals.set(stlmWallet, (walletStlmTotals.get(stlmWallet) ?? 0) + stlmAmountNum);
          }
        });

      parsed.forEach((row) => {
        const key = row.wallet.toLowerCase();
        const computedDP  = walletDPTotals.get(key) ?? 0;
        const computedWD  = walletWDTotals.get(key) ?? 0;
        const computedTopUp = walletTopUpTotals.get(key) ?? 0;
        const computedStlm  = walletStlmTotals.get(key) ?? 0;
        if (computedDP)  row.totalDP = computedDP;
        if (computedWD)  row.totalWD = -computedWD;
        if (computedTopUp) row.bdTransferIn = computedTopUp;
        if (computedStlm)  row.stlm = -computedStlm;
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

      const cashGoByDate = new Map<string, { bk: number; ng: number }>();
      parseCsvLines(cashGoText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const dateObj = parseSheetDate((row[1] ?? '').replace(/"/g, '').trim());
          if (!dateObj) return;
          cashGoByDate.set(dateObj.toDateString(), { bk: clean(row[4]), ng: clean(row[5]) });
        });

      const toCashGoPoint = (d: Date): TrendPoint => {
        const totals = cashGoByDate.get(d.toDateString()) ?? { bk: 0, ng: 0 };
        return {
          day: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
          tooltipLabel: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          total: totals.bk + totals.ng,
          series: { bk: totals.bk, ng: totals.ng },
        };
      };

      const now = getBusinessToday();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      const weekHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 6);
      const cashGoWeekPoints: TrendPoint[] = Array.from({ length: 7 }, (_, i) =>
        toCashGoPoint(new Date(weekHistoryStart.getFullYear(), weekHistoryStart.getMonth(), weekHistoryStart.getDate() + i))
      );

      const monthHistoryStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - 29);
      const cashGoMonthPoints: TrendPoint[] = Array.from({ length: 30 }, (_, i) =>
        toCashGoPoint(new Date(monthHistoryStart.getFullYear(), monthHistoryStart.getMonth(), monthHistoryStart.getDate() + i))
      );

      setRows(parsed);
      setOpeningTotal(openingSum);
      setAgentRows(mergedAgentRows);
      setCashGoWeekData(cashGoWeekPoints);
      setCashGoMonthData(cashGoMonthPoints);
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

  const totalDPSum  = dataRows.reduce((sum, row) => sum + row.totalDP, 0);
  const totalWDSum  = dataRows.reduce((sum, row) => sum + Math.abs(row.totalWD), 0);
  const runningBalTotal = dataRows.reduce((sum, row) => sum + row.runningBal, 0);
  const runningVsOpening = runningBalTotal - openingTotal;
  const bdTransferInSum = dataRows.reduce((sum, row) => sum + row.bdTransferIn, 0);
  const stlmSum = dataRows.reduce((sum, row) => sum + row.stlm, 0);
  const totalWDSignedSum = dataRows.reduce((sum, row) => sum + row.totalWD, 0);

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
        { label: 'Total Deposit', bigValue: fmtAbbrev(totalDPSum), bigNegative: false, subAmount: fmt(totalDPSum), subPositive: true },
        { label: 'Total Withdrawal', bigValue: fmtAbbrev(totalWDSum), bigNegative: false, subAmount: fmt(totalWDSum), subPositive: false },
        { label: 'Actual Balance', bigValue: fmtAbbrev(actualBalTotal), bigNegative: actualBalTotal < 0, subAmount: fmt(actualBalTotal), subPositive: actualBalTotal >= 0 },
        { label: 'Running Balance', bigValue: fmtAbbrev(runningBalTotal), bigNegative: runningBalTotal < 0, subAmount: fmt(runningVsOpening), subSuffix: 'vs opening', subPositive: runningVsOpening >= 0, showArrow: true },
      ]
    : [];

  const cardThemes = [
    { Icon: TrendingUp, iconBg: 'bg-emerald-50 dark:bg-emerald-500/10', iconColor: 'text-emerald-600 dark:text-emerald-400' },
    { Icon: TrendingDown, iconBg: 'bg-rose-50 dark:bg-rose-500/10', iconColor: 'text-rose-500 dark:text-rose-400' },
    { Icon: Wallet, iconBg: 'bg-slate-100 dark:bg-white/10', iconColor: 'text-slate-900 dark:text-white' },
    { Icon: Activity, iconBg: 'bg-amber-50 dark:bg-amber-500/10', iconColor: 'text-amber-600 dark:text-amber-400' },
  ];

  const rankBadgeClass = [
    'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-400',
    'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
    'bg-orange-100 text-orange-600 dark:bg-orange-400/20 dark:text-orange-400',
    'bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
  ];

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      <header className="sticky top-0 z-30 border-b bg-background/95 py-0 px-4 backdrop-blur-sm md:px-8">
        <div className="flex h-12 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-primary" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">Cash Out Overview</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={fetchData} disabled={spinning} aria-label="Refresh" title="Refresh">
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>
      </header>

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        {loading && (
          <div className="relative flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i} className="gap-0 rounded-2xl border py-0 shadow-sm">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <Skeleton className="h-2.5 w-20 rounded-md" />
                        <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
                      </div>
                      <Skeleton className="mt-3 h-7 w-24 rounded-md" />
                      <Skeleton className="mt-2 h-2.5 w-28 rounded-md" />
                    </CardContent>
                  </Card>
                ))}
              </section>

              <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="border-b !py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Skeleton className="h-4 w-28 rounded-md" />
                    <Skeleton className="h-7 w-24 rounded-lg" />
                  </div>
                </CardHeader>
                <CardContent className="h-[280px] p-3 pt-4">
                  <Skeleton className="h-full w-full rounded-xl" />
                </CardContent>
              </Card>

              <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="border-b !py-3">
                  <Skeleton className="h-4 w-32 rounded-md" />
                </CardHeader>
                <CardContent className="p-0">
                  <Table className="min-w-[700px]">
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        {walletColumns.map((col) => (
                          <TableHead key={col.key}><Skeleton className="h-2.5 w-14 rounded-md" /></TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from({ length: 4 }).map((_, ri) => (
                        <TableRow key={ri}>
                          {walletColumns.map((col) => (
                            <TableCell key={col.key}><Skeleton className="h-3 w-16 rounded-md" /></TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            <aside className="flex flex-col gap-4 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[310px]">
              <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="flex-row items-center justify-between border-b !py-3">
                  <Skeleton className="h-4 w-36 rounded-md" />
                  <Skeleton className="h-3 w-10 rounded-md" />
                </CardHeader>
                <CardContent className="p-0">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0">
                      <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Skeleton className="h-3 w-20 rounded-md" />
                        <Skeleton className="h-2 w-24 rounded-md" />
                      </div>
                      <Skeleton className="h-3 w-16 rounded-md" />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="gap-0 flex-1 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="flex-row items-center justify-between border-b !py-3">
                  <Skeleton className="h-4 w-36 rounded-md" />
                  <Skeleton className="h-5 w-12 rounded-md" />
                </CardHeader>
                <CardContent className="p-0">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0">
                      <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Skeleton className="h-3 w-20 rounded-md" />
                        <Skeleton className="h-2 w-16 rounded-md" />
                      </div>
                      <div className="shrink-0 space-y-1.5 text-right">
                        <Skeleton className="ml-auto h-3 w-20 rounded-md" />
                        <Skeleton className="ml-auto h-2 w-14 rounded-md" />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </aside>
          </div>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && (
          <div className="relative flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-1 flex-col gap-4 lg:w-[calc(100%-326px)] lg:flex-none">
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {summaryCards.map((card, i) => {
                  const { Icon, iconBg, iconColor } = cardThemes[i] ?? cardThemes[0];
                  return (
                    <Card key={card.label} className="gap-0 rounded-2xl border py-0 shadow-sm hover:shadow-md">
                      <CardContent className="p-4">
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
                      </CardContent>
                    </Card>
                  );
                })}
              </section>

              <CashGoTrendShadcn title="CashGo Trend" seriesDefs={CASHGO_SERIES_DEFS} weekData={cashGoWeekData} monthData={cashGoMonthData} />

              <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="border-b !py-3">
                  <CardTitle className="text-[13px] font-semibold">Wallet Summary</CardTitle>
                </CardHeader>
                <CardContent className="hidden overflow-x-auto p-0 sm:block">
                  <Table className="min-w-[700px]">
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        {walletColumns.map((col, ci) => (
                          <TableHead key={col.key} className={`text-[10px] uppercase tracking-[0.06em] ${ci === 0 ? 'text-left' : 'text-right'}`}>
                            {col.label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dataRows.length > 0 ? dataRows.map((row) => (
                        <TableRow key={row.wallet}>
                          <TableCell className="text-left">
                            <span className="text-[12px] font-bold text-foreground">{row.wallet}</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                            {fmtCell(row.totalDP)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-medium text-rose-600 dark:text-rose-400">
                            {fmtCell(row.totalWD, true)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] text-foreground">
                            {fmtCell(row.bdTransferIn)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] text-foreground">
                            {fmtCell(row.stlm, true)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-medium text-foreground">
                            {fmtCell(row.actualBal)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className={`tabular-nums text-[11px] font-bold ${row.runningBal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {fmtCell(row.runningBal, true)}
                            </div>
                            <div className={`mt-0.5 tabular-nums text-[10px] font-medium ${row.runningBal >= row.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {row.runningBal >= row.opening ? '▲' : '▼'} {fmtCell(row.runningBal - row.opening)}
                            </div>
                          </TableCell>
                        </TableRow>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-[11px] text-muted-foreground">No wallet data found.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                    {totalRow && (
                      <tfoot>
                        <TableRow className="border-t-2 bg-muted/20">
                          <TableCell className="text-left">
                            <span className="text-[12px] font-bold text-foreground">Total</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-bold text-foreground">{fmtCell(totalDPSum)}</TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-bold text-foreground">{fmtCell(totalWDSignedSum, true)}</TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-bold text-foreground">{fmtCell(bdTransferInSum)}</TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-bold text-foreground">{fmtCell(stlmSum, true)}</TableCell>
                          <TableCell className="text-right tabular-nums text-[11px] font-bold text-foreground">{fmtCell(actualBalTotal)}</TableCell>
                          <TableCell className="text-right">
                            <div className="tabular-nums text-[11px] font-bold text-foreground">{fmtCell(runningBalTotal, true)}</div>
                            <div className={`mt-0.5 tabular-nums text-[10px] font-medium ${runningBalTotal >= openingTotal ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {runningBalTotal >= openingTotal ? '▲' : '▼'} {fmtCell(runningVsOpening)}
                            </div>
                          </TableCell>
                        </TableRow>
                      </tfoot>
                    )}
                  </Table>
                </CardContent>

                <div className="flex flex-col gap-3 p-4 sm:hidden">
                  {dataRows.length > 0 ? dataRows.map((row) => (
                    <Card key={row.wallet} className="gap-0 rounded-xl border py-0 shadow-none">
                      <CardContent className="p-4">
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
                        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t pt-3">
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
                      </CardContent>
                    </Card>
                  )) : (
                    <div className="py-8 text-center text-[11px] text-muted-foreground">No wallet data found.</div>
                  )}
                </div>
              </Card>
            </div>

            <aside className="flex flex-col gap-4 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[310px]">
              <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
                <CardHeader className="flex-row items-center justify-between border-b !py-3">
                  <CardTitle className="text-[13px] font-semibold">Top Performer Wallet</CardTitle>
                  <span className="text-[10px] font-medium text-muted-foreground">Net P&amp;L</span>
                </CardHeader>
                <CardContent className="p-0">
                  {walletGainRanking.map((item, index) => (
                    <div
                      key={item.wallet}
                      className={`flex items-center gap-3 border-b px-4 py-2.5 last:border-0 ${index === 0 ? 'bg-rose-50/70 dark:bg-rose-500/5' : ''}`}
                    >
                      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${rankBadgeClass[index] ?? rankBadgeClass[3]}`}>
                        {index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-foreground">{item.wallet}</p>
                        <p className="text-[10px] text-muted-foreground">Bal: {fmtCell(item.actualBal, true)}</p>
                      </div>
                      <span className={`shrink-0 text-[12px] font-bold tabular-nums ${item.gain < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {fmtCell(item.gain, true)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="gap-0 flex max-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border py-0 shadow-sm lg:max-h-none lg:min-h-0">
                <CardHeader className="flex-row items-center justify-between border-b !py-3">
                  <CardTitle className="text-[13px] font-semibold">High Volume Agents</CardTitle>
                  <Badge>Top {top50Agents.length}</Badge>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
                  {top50Agents.length > 0 ? top50Agents.map((agent, index) => {
                    const diff = agent.runningBalance - agent.opening;
                    const up = diff >= 0;
                    return (
                      <div
                        key={agent.agentName}
                        className={`flex items-center gap-3 border-b px-4 py-2.5 last:border-0 hover:bg-muted/40 ${index < 3 ? 'bg-muted/20' : ''}`}
                      >
                        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${rankBadgeClass[index] ?? 'text-[10px] font-semibold text-muted-foreground'}`}>
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
                </CardContent>
              </Card>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
