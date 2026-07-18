'use client';

// Restyled with shadcn components (Card/Table/Badge/Button/Skeleton) instead
// of the previous hand-rolled Design System v2 markup — same data, same
// computations, same labels/copy. See app/shadcn-demo/page.tsx for the
// scratch page this was validated against before being applied here.

import { useEffect, useState, useCallback, useMemo } from 'react';
import Image from 'next/image';
import * as XLSX from 'xlsx';
import { RefreshCw, ArrowLeftRight, Wallet, Banknote, Building2, Download, Send, ChevronUp, ChevronDown } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import ConnectionErrorState from '../components/ConnectionErrorState';
import Toast, { type ToastState } from '../components/Toast';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { getBusinessToday, toBusinessDate, parseCardCutoffDate, manilaMidnight, manilaFields } from '../lib/businessDate';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Card,
  CardContent,
  CardDescription,
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
/* Data layer — copied verbatim from app/balance-overview/page.tsx.   */
/* No logic changes; only the render layer below is different.        */
/* ------------------------------------------------------------------ */

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

function cleanSigned(val: string): number {
  const raw = (val ?? '').replace(/"/g, '').trim();
  if (!raw || raw === '-') return 0;
  const negative = raw.startsWith('(') && raw.endsWith(')');
  const inner = negative ? raw.slice(1, -1) : raw;
  const num = parseFloat(inner.replace(/,/g, '')) || 0;
  return negative ? -num : num;
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

function fmtAbbrevTrimmed(num: number): string {
  return fmtAbbrev(num).replace(/\.00(?=[A-Z]|$)/, '');
}

function fmtQuotaPct(pct: number): string {
  if (pct >= 100) return '100%';
  return `${pct.toFixed(1)}%`;
}

const WALLET_ORDER = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];
const WALLET_DISPLAY_NAMES: Record<string, string> = {
  BKASH: 'Bkash',
  NAGAD: 'Nagad',
  ROCKET: 'Rocket',
  UPAY: 'UPay',
};
const WALLET_LOGOS: Record<string, string> = {
  BKASH: '/wallets/Bkash.png',
  NAGAD: '/wallets/Nagad.png',
  ROCKET: '/wallets/Rocket.png',
  UPAY: '/wallets/Upay.png',
};
const WALLET_COLORS: Record<string, string> = {
  BKASH: '#E2136E',
  NAGAD: '#F5821F',
  ROCKET: '#8C3494',
  UPAY: '#3EB549',
};

function WalletLogo({ wallet, muted }: { wallet: string; muted?: boolean }) {
  const [imgError, setImgError] = useState(false);
  const src = WALLET_LOGOS[wallet];

  if (!src || imgError) {
    return (
      <div
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white ${muted ? 'grayscale opacity-50' : ''}`}
        style={{ backgroundColor: WALLET_COLORS[wallet] ?? '#94a3b8' }}
      >
        {wallet.charAt(0)}
      </div>
    );
  }

  return (
    <div className={`relative h-5 w-5 shrink-0 overflow-hidden rounded-md ${muted ? 'grayscale opacity-50' : ''}`}>
      <Image
        src={src}
        alt={WALLET_DISPLAY_NAMES[wallet] ?? wallet}
        fill
        sizes="20px"
        className="object-contain"
        onError={() => setImgError(true)}
      />
    </div>
  );
}

type WalletFlow = {
  wallet: string;
  totalDP: number;
  totalWD: number;
  bdTransferIn: number;
  stlmOut: number;
  actualBal: number;
  runningBal: number;
  opening: number;
};

function parseSheetBlock(text: string): WalletFlow[] {
  const lines = text.trim().split('\n').slice(1);
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cols = line.split(',');
      return {
        wallet: (cols[0] ?? '').replace(/"/g, '').trim(),
        totalDP: clean(cols[1]),
        totalWD: clean(cols[2]),
        bdTransferIn: clean(cols[3]),
        stlmOut: clean(cols[4]),
        actualBal: clean(cols[5]),
        runningBal: clean(cols[6]),
        opening: clean(cols[7]),
      };
    });
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function parseCashGoDate(raw: string): Date | null {
  const match = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = parseInt(match[2], 10);
  const { year } = manilaFields(new Date());
  return manilaMidnight(year, monthIndex, day);
}

function parseTodayCashGo(text: string, rangeStart: Date): { bk: number; ng: number; quotaBk: number; quotaNg: number } {
  const now = getBusinessToday();
  const validTimes = new Set([now.getTime(), rangeStart.getTime()]);
  const totals = { bk: 0, ng: 0, quotaBk: 0, quotaNg: 0 };
  const lines = text.trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const date = parseCashGoDate((cols[1] ?? '').replace(/"/g, '').trim());
    if (date && validTimes.has(date.getTime())) {
      totals.bk += clean(cols[4]);
      totals.ng += clean(cols[5]);
      totals.quotaBk += clean(cols[2]);
      totals.quotaNg += clean(cols[3]);
    }
  }
  return totals;
}

function parseSlashDate(raw: string): Date | null {
  const parts = (raw ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return manilaMidnight(y, m - 1, d);
}

function parseTodayBundle(text: string, rangeStart: Date): { nagad: number; rocket: number; upay: number } {
  const now = getBusinessToday();
  const validTimes = new Set([now.getTime(), rangeStart.getTime()]);
  const totals = { nagad: 0, rocket: 0, upay: 0 };
  const addRow = (nameRaw: string, amountRaw: string, dateRaw: string, walletRaw: string, typeRaw: string) => {
    const type = (typeRaw ?? '').replace(/"/g, '').trim().toUpperCase();
    if (type !== 'BUNDLE TRANSFER') return;
    const name = (nameRaw ?? '').replace(/"/g, '').trim();
    if (!name || name === '-') return;
    const amount = Math.abs(clean(amountRaw));
    if (!amount) return;
    const date = parseSlashDate((dateRaw ?? '').replace(/"/g, '').trim());
    if (!date || !validTimes.has(date.getTime())) return;
    const wallet = (walletRaw ?? '').replace(/"/g, '').trim().toUpperCase();
    if (wallet === 'NAGAD') totals.nagad += amount;
    else if (wallet === 'ROCKET') totals.rocket += amount;
    else if (wallet === 'UPAY') totals.upay += amount;
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    addRow(cols[7], cols[8], cols[9], cols[10], cols[11]);
    addRow(cols[22], cols[23], cols[24], cols[25], cols[26]);
  });

  return totals;
}

function parseCashoutReportCutoffDate(text: string): Date | null {
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const cols = line.split(',');
    const cell = (cols[6] ?? '').replace(/"/g, '').trim();
    const parsed = parseCardCutoffDate(cell);
    if (parsed) return parsed;
  }
  return null;
}

function parseSendMoneyReportCutoffDate(text: string): Date | null {
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const cols = line.split(',');
    const cell = (cols[8] ?? '').replace(/"/g, '').trim();
    const parsed = parseCardCutoffDate(cell);
    if (parsed) return parsed;
  }
  return null;
}

function computeCashoutTopUpStlm(text: string, cutoff: Date | null): { topUp: number; stlm: number } {
  let topUp = 0;
  let stlm = 0;
  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      topUp += topUpAmount;
    }
    const stlmAgent = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      stlm += stlmAmount;
    }
  });
  return { topUp, stlm: -stlm };
}

function computeCashoutWalletTopUpStlm(text: string, cutoff: Date | null): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (wallet: string, key: 'topUp' | 'stlm', amount: number) => {
    const existing = totals.get(wallet) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(wallet, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    const topUpWallet = (cols[4] ?? '').replace(/"/g, '').trim().toUpperCase();
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpWallet && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      add(topUpWallet, 'topUp', topUpAmount);
    }
    const stlmAgent = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    const stlmWallet = (cols[10] ?? '').replace(/"/g, '').trim().toUpperCase();
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmWallet && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      add(stlmWallet, 'stlm', stlmAmount);
    }
  });

  return totals;
}

const SSP_LINE1_BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const SSP_LINE1_SKIP_GROUPS = ['wallet with issue', 'disconnected', 'dc account'];

function computeSspLine1Brand(groups: string[]): string {
  const counts = new Map<string, number>();
  groups.forEach((group) => {
    const trimmed = (group ?? '').trim();
    if (!trimmed || trimmed === '-') return;
    if (SSP_LINE1_SKIP_GROUPS.some((skip) => trimmed.toLowerCase().includes(skip))) return;
    const code = trimmed.slice(0, 2).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  });

  if (counts.size === 0) return '−';

  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.keys()).filter((code) => counts.get(code) === maxCount);
  const priorityTied = tied.filter((code) => SSP_LINE1_BRAND_PRIORITY.includes(code));

  if (priorityTied.length > 0) {
    priorityTied.sort((a, b) => SSP_LINE1_BRAND_PRIORITY.indexOf(a) - SSP_LINE1_BRAND_PRIORITY.indexOf(b));
    return priorityTied[0];
  }

  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

function resolveSspLine1Brand(groups: string[], agentName: string): string {
  const brand = computeSspLine1Brand(groups);
  if (brand !== '−') return brand;
  return SSP_LINE1_BRAND_PRIORITY.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

function stripSspLine1BrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && SSP_LINE1_BRAND_PRIORITY.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

function computeCashoutBrandTopUpStlm(
  text: string,
  cutoff: Date | null,
  brandGroups: Map<string, string[]>
): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (brand: string, key: 'topUp' | 'stlm', amount: number) => {
    if (brand === '−') return;
    const existing = totals.get(brand) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(brand, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = stripSspLine1BrandSuffix((cols[1] ?? '').replace(/"/g, '').trim());
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      const brand = resolveSspLine1Brand(brandGroups.get(topUpAgent) ?? [], topUpAgent);
      add(brand, 'topUp', topUpAmount);
    }
    const stlmAgent = stripSspLine1BrandSuffix((cols[7] ?? '').replace(/"/g, '').trim());
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      const brand = resolveSspLine1Brand(brandGroups.get(stlmAgent) ?? [], stlmAgent);
      add(brand, 'stlm', stlmAmount);
    }
  });

  return totals;
}

function computeSendMoneyTopUpStlm(text: string, cutoff: Date | null): { topUp: number; stlm: number } {
  let topUp = 0;
  let stlm = 0;
  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpName = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    if (topUpName && topUpName !== '-' && topUpAmount && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      topUp += topUpAmount;
    }
    const stlmName = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    if (stlmName && stlmName !== '-' && stlmAmount && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      stlm += stlmAmount;
    }
  });
  return { topUp, stlm: -stlm };
}

function computeSendMoneyWalletTopUpStlm(text: string, cutoff: Date | null): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (wallet: string, key: 'topUp' | 'stlm', amount: number) => {
    const existing = totals.get(wallet) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(wallet, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    const topUpWallet = (cols[4] ?? '').replace(/"/g, '').trim().toUpperCase();
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpWallet && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      add(topUpWallet, 'topUp', topUpAmount);
    }
    const stlmAgent = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    const stlmWallet = (cols[10] ?? '').replace(/"/g, '').trim().toUpperCase();
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmWallet && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      add(stlmWallet, 'stlm', stlmAmount);
    }
  });

  return totals;
}

const SSP_LINE1_SENDMONEY_BRAND_CODES = [...SSP_LINE1_BRAND_PRIORITY, 'SH'];

function resolveSendMoneyBrandFromWalletName(walletName: string): string {
  const segment = (walletName.split('-')[1] ?? '').toUpperCase();
  const code = SSP_LINE1_SENDMONEY_BRAND_CODES.find((c) => segment.startsWith(c));
  return code ?? '−';
}

function computeSendMoneyBrandTopUpStlm(text: string, cutoff: Date | null): Map<string, { topUp: number; stlm: number }> {
  const totals = new Map<string, { topUp: number; stlm: number }>();
  const add = (brand: string, key: 'topUp' | 'stlm', amount: number) => {
    if (brand === '−') return;
    const existing = totals.get(brand) ?? { topUp: 0, stlm: 0 };
    existing[key] += amount;
    totals.set(brand, existing);
  };

  text.trim().split('\n').slice(1).forEach((line) => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const topUpAgent = (cols[1] ?? '').replace(/"/g, '').trim();
    const topUpAmount = clean(cols[2]);
    const topUpDate = cutoff ? parseSlashDate((cols[3] ?? '').replace(/"/g, '').trim()) : null;
    if (topUpAgent && topUpAgent !== '-' && topUpAmount && (!cutoff || (topUpDate && topUpDate >= cutoff))) {
      add(resolveSendMoneyBrandFromWalletName(topUpAgent), 'topUp', topUpAmount);
    }
    const stlmAgent = (cols[7] ?? '').replace(/"/g, '').trim();
    const stlmAmount = Math.abs(clean(cols[8]));
    const stlmDate = cutoff ? parseSlashDate((cols[9] ?? '').replace(/"/g, '').trim()) : null;
    if (stlmAgent && stlmAgent !== '-' && stlmAmount && (!cutoff || (stlmDate && stlmDate >= cutoff))) {
      add(resolveSendMoneyBrandFromWalletName(stlmAgent), 'stlm', stlmAmount);
    }
  });

  return totals;
}

type SspLine1Row = {
  brand: string;
  opening: number;
  deposit: number;
  withdrawal: number;
  topUp: number;
  settlement: number;
  total: number;
};

function parseSspLine1(text: string): Omit<SspLine1Row, 'topUp' | 'settlement'>[] {
  const toRow = (cols: string[]): Omit<SspLine1Row, 'topUp' | 'settlement'> => ({
    brand: (cols[0] ?? '').replace(/"/g, '').trim(),
    opening: cleanSigned(cols[1]),
    deposit: cleanSigned(cols[2]),
    withdrawal: cleanSigned(cols[3]),
    total: cleanSigned(cols[5]),
  });

  return text.trim().split('\n').slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => toRow(line.split(',')));
}

type BrandCashRow = {
  brand: string;
  sspAg: number;
  sspPs: number;
  ess: number;
  autopay: number;
  expay: number;
  totalBrandCIH: number;
};

function parseBrandCashInhand(text: string): { rows: BrandCashRow[]; total: BrandCashRow | null } {
  const toRow = (cols: string[]): BrandCashRow => ({
    brand: (cols[0] ?? '').replace(/"/g, '').trim(),
    sspAg: cleanSigned(cols[1]),
    sspPs: cleanSigned(cols[2]),
    ess: cleanSigned(cols[3]),
    autopay: cleanSigned(cols[4]),
    expay: cleanSigned(cols[5]),
    totalBrandCIH: cleanSigned(cols[6]),
  });

  const parsed = text.trim().split('\n').slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => toRow(line.split(',')));

  const totalIndex = parsed.findIndex((r) => r.brand.toUpperCase() === 'TOTAL PG CIH');
  if (totalIndex === -1) return { rows: parsed, total: null };
  return { rows: parsed.filter((_, i) => i !== totalIndex), total: parsed[totalIndex] };
}

type CardWallet = {
  wallet: string;
  runningBal: number;
  actualBal: number;
  delta: number;
  comingSoon?: boolean;
};

type TodayWallet = {
  key: string;
  label: string;
  value: number;
  quota?: number;
};

type TodayQuota = {
  processed: number;
  total: number;
};

type CardData = {
  productLabel: string;
  product: 'cashout' | 'sendmoney';
  opening: number;
  deposit: number;
  withdrawal: number;
  bdTransferIn: number;
  stlmOut: number;
  ending: number;
  wallets: CardWallet[];
  todayLabel: string;
  todayWallets: TodayWallet[];
  todayQuota: TodayQuota | null;
};

function buildCardData(
  rows: WalletFlow[],
  product: 'cashout' | 'sendmoney',
  productLabel: string,
  todayLabel: string,
  todayWallets: TodayWallet[],
  todayQuota: TodayQuota | null,
  topUpStlm: { topUp: number; stlm: number },
  openingOverride?: number,
  walletRunningBalOverride?: Map<string, number>
): CardData {
  const total = rows.find((r) => r.wallet.toUpperCase() === 'TOTAL');
  const opening = openingOverride ?? total?.opening ?? 0;
  const deposit = total?.totalDP ?? 0;
  const withdrawal = total?.totalWD ?? 0;
  const bdTransferIn = topUpStlm.topUp;
  const stlmOut = topUpStlm.stlm;
  const ending = opening + deposit - withdrawal + bdTransferIn + stlmOut;

  const wallets: CardWallet[] = WALLET_ORDER.map((key) => {
    const row = rows.find((r) => r.wallet.toUpperCase() === key);
    const runningBal = walletRunningBalOverride?.get(key) ?? row?.runningBal ?? 0;
    return {
      wallet: key,
      runningBal,
      actualBal: row?.actualBal ?? 0,
      delta: row ? runningBal - row.opening : 0,
      comingSoon: product === 'sendmoney' && key === 'BKASH',
    };
  });

  return { productLabel, product, opening, deposit, withdrawal, bdTransferIn, stlmOut, ending, wallets, todayLabel, todayWallets, todayQuota };
}

function flowValueDisplay(num: number): { text: string; colorClass: string } {
  if (Math.abs(num) < 0.005) {
    return { text: fmt(num), colorClass: 'text-foreground' };
  }
  return {
    text: `${num >= 0 ? '+' : '−'}${fmt(num)}`,
    colorClass: num >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
  };
}

function cihValueDisplay(value: number): { text: string; className: string } {
  const zero = Math.abs(value) < 0.005;
  const negative = value < 0;
  return {
    text: zero ? '−' : `${negative ? '−' : ''}${fmt(value)}`,
    className: zero ? 'text-muted-foreground' : negative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
  };
}

const AUTOPAY_UNSUPPORTED_BRANDS = ['B3', 'B4', 'B5', 'J1', 'T1'];

const BRAND_CASH_COLUMNS: { key: keyof Omit<BrandCashRow, 'brand'>; label: string }[] = [
  { key: 'sspAg', label: 'CashOut' },
  { key: 'sspPs', label: 'SendMoney' },
  { key: 'ess', label: 'ESS' },
  { key: 'autopay', label: 'Autopay' },
  { key: 'expay', label: 'Expay' },
  { key: 'totalBrandCIH', label: 'Total CIH' },
];

const SSP_LINE1_COLUMNS: { key: keyof Omit<SspLine1Row, 'brand'>; label: string }[] = [
  { key: 'opening', label: 'Opening Balance' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'withdrawal', label: 'Withdrawal' },
  { key: 'topUp', label: 'Top Up' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'total', label: 'Total' },
];

/* ------------------------------------------------------------------ */
/* Render layer — shadcn components (Card/Table/Badge/Button/Skeleton) */
/* instead of app/balance-overview/page.tsx's own hand-rolled markup.  */
/* Same copy/labels/data throughout.                                   */
/* ------------------------------------------------------------------ */

function FlowRow({ label, value, valueClass, last }: { label: string; value: string; valueClass?: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2.5 ${last ? '' : 'border-b'}`}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={`text-[13px] font-semibold tabular-nums ${valueClass ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function WalletTile({ wallet }: { wallet: CardWallet }) {
  const name = WALLET_DISPLAY_NAMES[wallet.wallet] ?? wallet.wallet;

  if (wallet.comingSoon) {
    return (
      <Card className="gap-0 rounded-xl border bg-muted/20 py-0 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted/50 hover:shadow-md">
        <CardContent className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <WalletLogo wallet={wallet.wallet} muted />
            <span className="text-[13px] text-muted-foreground">{name}</span>
          </div>
          <p className="mt-2 text-[14px] font-medium text-muted-foreground">Coming soon</p>
        </CardContent>
      </Card>
    );
  }

  const up = wallet.delta >= 0;
  return (
    <Card className="gap-0 rounded-xl border py-0 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted/50 hover:shadow-md">
      <CardContent className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <WalletLogo wallet={wallet.wallet} />
          <span className="text-[13px] text-muted-foreground">{name}</span>
        </div>
        <p className="mt-1.5 text-[17px] font-bold tabular-nums text-foreground">{fmtAbbrev(wallet.runningBal)}</p>
        <p className={`mt-0.5 text-[12px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
          {up ? '▴' : '▾'} {fmtAbbrev(wallet.delta)}
        </p>
        <div className="mt-1.5 flex items-center justify-between border-t pt-1.5">
          <span className="text-[11px] text-muted-foreground">Actual Balance</span>
          <span className="text-[11px] font-semibold tabular-nums text-foreground">{fmtAbbrev(wallet.actualBal)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function TodayStrip({ label, wallets, quota }: { label: string; wallets: TodayWallet[]; quota: TodayQuota | null }) {
  const active = wallets.filter((w) => w.value > 0).sort((a, b) => b.value - a.value);
  const total = active.reduce((sum, w) => sum + w.value, 0);
  const quotaPct = quota && quota.total > 0 ? (quota.processed / quota.total) * 100 : null;

  return (
    <div className="rounded-[10px] px-4 py-3" style={{ background: 'var(--product-accent-soft)' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: 'var(--product-accent)' }}>
            <ArrowLeftRight size={12} className="text-white" />
          </div>
          <span className="truncate text-[13px] font-semibold text-foreground">{label} · Today</span>
        </div>
        <span className="shrink-0 text-[18px] font-medium tabular-nums text-foreground">{fmtAbbrev(total)}</span>
      </div>

      {active.length > 0 && (
        <>
          <div className="mt-2.5 h-[6px] w-full overflow-hidden rounded-full border bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: quotaPct !== null ? `${Math.min(quotaPct, 100)}%` : '100%', background: 'var(--product-accent)' }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {active.map((w) => (
                <span key={w.key} className="text-[12px] text-muted-foreground">
                  {w.label}{' '}
                  <span className={`tabular-nums text-foreground ${w.key === 'ng' ? 'font-semibold' : 'font-medium'}`}>
                    {w.quota ? `${fmtAbbrevTrimmed(w.value)}/${fmtAbbrevTrimmed(w.quota)}` : fmtAbbrev(w.value)}
                  </span>
                </span>
              ))}
            </div>
            {quotaPct !== null && (
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-foreground">
                {fmtQuotaPct(quotaPct)}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BalanceCard({ data }: { data: CardData }) {
  return (
    <Card data-product={data.product} className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
      <CardContent className="p-5">
        <h3 className="mb-4 inline-flex items-center gap-1.5 border-b-2 pb-1 text-[15px] font-semibold text-foreground" style={{ borderColor: 'var(--product-accent)' }}>
          {data.product === 'cashout' ? (
            <Wallet size={14} style={{ color: 'var(--product-accent)' }} />
          ) : (
            <Banknote size={14} style={{ color: 'var(--product-accent)' }} />
          )}
          {data.productLabel}
        </h3>

        <div>
          <FlowRow label="Opening Balance" value={`${data.opening < 0 ? '−' : ''}${fmt(data.opening)}`} />
          <FlowRow label="Deposit" value={Math.abs(data.deposit) < 0.005 ? fmt(data.deposit) : `+${fmt(data.deposit)}`} valueClass={Math.abs(data.deposit) < 0.005 ? undefined : 'text-emerald-600 dark:text-emerald-400'} />
          <FlowRow label="Withdrawal" value={Math.abs(data.withdrawal) < 0.005 ? fmt(data.withdrawal) : `−${fmt(data.withdrawal)}`} valueClass={Math.abs(data.withdrawal) < 0.005 ? undefined : 'text-rose-600 dark:text-rose-400'} />
          <FlowRow label="Top Up" value={flowValueDisplay(data.bdTransferIn).text} valueClass={flowValueDisplay(data.bdTransferIn).colorClass} />
          <FlowRow label="Settlement" value={flowValueDisplay(data.stlmOut).text} valueClass={flowValueDisplay(data.stlmOut).colorClass} last />
        </div>

        <div className="mt-3 rounded-[10px] bg-muted/40 px-3.5 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold text-foreground">Ending Balance</span>
            <span className={`text-[17px] font-bold tabular-nums ${data.ending < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
              {data.ending < 0 ? '−' : ''}{fmt(data.ending)}
            </span>
          </div>
          <div className={`mt-1 flex items-center justify-end gap-1 text-[12px] font-medium ${data.ending >= data.opening ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
            <span>{data.ending >= data.opening ? '▲' : '▼'}</span>
            <span className="tabular-nums">{fmt(data.ending - data.opening)}</span>
          </div>
        </div>

        <div className="mt-3">
          <TodayStrip label={data.todayLabel} wallets={data.todayWallets} quota={data.todayQuota} />
        </div>

        <div className="mb-3 mt-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="shrink-0 text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Wallet Breakdown</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {data.wallets.map((wallet) => (
            <WalletTile key={wallet.wallet} wallet={wallet} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm">
      <CardContent className="p-5">
        <Skeleton className="mb-4 h-[28px] w-32 rounded-md" />
        <div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`flex items-center justify-between py-2.5 ${i < 4 ? 'border-b' : ''}`}>
              <Skeleton className="h-[20px] w-20 rounded-md" />
              <Skeleton className="h-[20px] w-16 rounded-md" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-3 h-[71px] rounded-[10px]" />
        <Skeleton className="mt-3 h-[93px] rounded-[10px]" />
        <div className="mb-3 mt-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <Skeleton className="h-[18px] w-28 shrink-0 rounded-md" />
          <div className="h-px flex-1 bg-border" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[123px] rounded-xl" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CihCell({ value, bold }: { value: number; bold?: boolean }) {
  const display = cihValueDisplay(value);
  return (
    <TableCell className={`text-center text-[13px] tabular-nums ${bold ? 'font-bold' : 'font-medium'} ${display.className}`}>
      {display.text}
    </TableCell>
  );
}

function NotSupportedCell() {
  return (
    <TableCell className="text-center text-[13px] font-medium italic text-muted-foreground">
      Not Supported
    </TableCell>
  );
}

type SspLine1SortKey = keyof SspLine1Row;
type BrandCashSortKey = keyof BrandCashRow;

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-muted-foreground opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={12} className="text-primary" />
  ) : (
    <ChevronDown size={12} className="text-primary" />
  );
}

function exportXlsx(fileNamePrefix: string, sheetName: string, headers: string[], rows: (string | number)[][]) {
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  XLSX.writeFile(workbook, `${fileNamePrefix}_${datePart}_${timePart}.xlsx`);
}

function SspLine1Section({
  rows,
  title,
  subtitle,
  exportFileName,
  exportSheetName,
}: {
  rows: SspLine1Row[];
  title: string;
  subtitle: string;
  exportFileName: string;
  exportSheetName: string;
}) {
  const [sortColumn, setSortColumn] = useState<SspLine1SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleHeaderClick = useCallback((key: SspLine1SortKey) => {
    if (sortColumn !== key) {
      setSortColumn(key);
      setSortDirection('desc');
    } else if (sortDirection === 'desc') {
      setSortDirection('asc');
    } else {
      setSortColumn(null);
      setSortDirection('desc');
    }
  }, [sortColumn, sortDirection]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      if (sortColumn === 'brand') {
        const comparison = a.brand.localeCompare(b.brand);
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const comparison = a[sortColumn] - b[sortColumn];
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [rows, sortColumn, sortDirection]);

  const handleExport = useCallback(() => {
    const headers = ['Brand', ...SSP_LINE1_COLUMNS.map((c) => c.label)];
    const data = rows.map((row) => [row.brand, ...SSP_LINE1_COLUMNS.map((c) => row[c.key])]);
    exportXlsx(exportFileName, exportSheetName, headers, data);
  }, [rows, exportFileName, exportSheetName]);

  return (
    <Card className="gap-0 overflow-hidden rounded-xl border py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b !py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Wallet size={16} />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-[15px] font-bold">{title}</CardTitle>
            <CardDescription className="truncate text-[13px]">{subtitle}</CardDescription>
          </div>
        </div>
        <Button type="button" size="sm" onClick={handleExport}>
          <Download size={13} />
          Export
        </Button>
      </CardHeader>

      <CardContent className="hidden overflow-x-auto p-0 sm:block">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead className="text-left">
                <button type="button" onClick={() => handleHeaderClick('brand')} className="flex items-center gap-1 hover:opacity-80">
                  Brand
                  <SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </TableHead>
              {SSP_LINE1_COLUMNS.map((col) => (
                <TableHead key={col.key} className="text-center">
                  <button type="button" onClick={() => handleHeaderClick(col.key)} className="flex w-full items-center justify-center gap-1 hover:opacity-80">
                    {col.label}
                    <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map((row) => (
              <TableRow key={row.brand}>
                <TableCell className="text-left text-[13px] font-semibold text-foreground">{row.brand}</TableCell>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <CihCell key={col.key} value={row[col.key]} bold={col.key === 'total'} />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.map((row) => {
          const totalDisplay = cihValueDisplay(row.total);
          return (
            <Card key={row.brand} className="gap-0 rounded-xl border py-0 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                  <div className="text-right">
                    <p className="text-[11px] text-muted-foreground">Total</p>
                    <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t pt-3">
                  {SSP_LINE1_COLUMNS.filter((col) => col.key !== 'total').map((col) => {
                    const display = cihValueDisplay(row[col.key]);
                    return (
                      <div key={col.key} className="min-w-0">
                        <p className="text-[11px] text-muted-foreground">{col.label}</p>
                        <p className={`mt-0.5 text-[10.5px] font-semibold tabular-nums ${display.className}`}>{display.text}</p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </Card>
  );
}

function SspLine1Skeleton() {
  return (
    <Card className="gap-0 overflow-hidden rounded-xl border py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b !py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div>
            <Skeleton className="h-[20px] w-48 rounded-md" />
            <Skeleton className="mt-1.5 h-[16px] w-64 rounded-md" />
          </div>
        </div>
        <Skeleton className="h-8 w-24 shrink-0 rounded-lg" />
      </CardHeader>
      <CardContent className="hidden overflow-x-auto p-0 sm:block">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="bg-muted/10" style={{ height: '42.5px' }}>
              <TableHead className="text-left"><Skeleton className="h-3 w-10 rounded-md" /></TableHead>
              {SSP_LINE1_COLUMNS.map((col) => (
                <TableHead key={col.key}><Skeleton className="mx-auto h-3 w-14 rounded-md" /></TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 10 }).map((_, i) => (
              <TableRow key={i} style={{ height: '44.5px' }}>
                <TableCell><Skeleton className="h-3 w-10 rounded-md" /></TableCell>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <TableCell key={col.key}><Skeleton className="mx-auto h-3 w-16 rounded-md" /></TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BrandCashInhandSection({ rows, total }: { rows: BrandCashRow[]; total: BrandCashRow | null }) {
  const [sortColumn, setSortColumn] = useState<BrandCashSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleHeaderClick = useCallback((key: BrandCashSortKey) => {
    if (sortColumn !== key) {
      setSortColumn(key);
      setSortDirection('desc');
    } else if (sortDirection === 'desc') {
      setSortDirection('asc');
    } else {
      setSortColumn(null);
      setSortDirection('desc');
    }
  }, [sortColumn, sortDirection]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      if (sortColumn === 'brand') {
        const comparison = a.brand.localeCompare(b.brand);
        return sortDirection === 'asc' ? comparison : -comparison;
      }
      const comparison = a[sortColumn] - b[sortColumn];
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [rows, sortColumn, sortDirection]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: BrandCashRow, key: keyof Omit<BrandCashRow, 'brand'>) => {
      if (key === 'autopay' && AUTOPAY_UNSUPPORTED_BRANDS.includes(row.brand.toUpperCase())) return 'Not Supported';
      return row[key];
    };
    const headers = ['Brand', ...BRAND_CASH_COLUMNS.map((c) => c.label)];
    const data = rows.map((row) => [row.brand, ...BRAND_CASH_COLUMNS.map((c) => getExportValue(row, c.key))]);
    if (total) data.push([total.brand, ...BRAND_CASH_COLUMNS.map((c) => total[c.key])]);
    exportXlsx('BRAND_BALANCE', 'Brand Balance', headers, data);
  }, [rows, total]);

  return (
    <Card data-telegram-capture="brand" className="gap-0 overflow-hidden rounded-xl border py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b !py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Building2 size={16} />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-[15px] font-bold">Brand Balance</CardTitle>
            <CardDescription className="truncate text-[13px]">Summary of cash in hand by brand and payment gateway</CardDescription>
          </div>
        </div>
        <Button type="button" size="sm" onClick={handleExport}>
          <Download size={13} />
          Export
        </Button>
      </CardHeader>

      <CardContent className="hidden overflow-x-auto p-0 sm:block">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead className="text-left">
                <button type="button" onClick={() => handleHeaderClick('brand')} className="flex items-center gap-1 hover:opacity-80">
                  Brand
                  <SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </TableHead>
              {BRAND_CASH_COLUMNS.map((col) => (
                <TableHead key={col.key} className="text-center">
                  <button type="button" onClick={() => handleHeaderClick(col.key)} className="flex w-full items-center justify-center gap-1 hover:opacity-80">
                    {col.label}
                    <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map((row) => (
              <TableRow key={row.brand}>
                <TableCell className="text-left text-[13px] font-semibold text-foreground">{row.brand}</TableCell>
                {BRAND_CASH_COLUMNS.map((col) =>
                  col.key === 'autopay' && AUTOPAY_UNSUPPORTED_BRANDS.includes(row.brand.toUpperCase()) ? (
                    <NotSupportedCell key={col.key} />
                  ) : (
                    <CihCell key={col.key} value={row[col.key]} bold={col.key === 'totalBrandCIH'} />
                  )
                )}
              </TableRow>
            ))}
          </TableBody>
          {total && (
            <tfoot>
              <TableRow className="border-t-2 bg-muted/20">
                <TableCell className="text-left text-[13px] font-bold text-foreground">{total.brand}</TableCell>
                {BRAND_CASH_COLUMNS.map((col) => (
                  <CihCell key={col.key} value={total[col.key]} bold />
                ))}
              </TableRow>
            </tfoot>
          )}
        </Table>
      </CardContent>

      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.map((row) => {
          const totalDisplay = cihValueDisplay(row.totalBrandCIH);
          return (
            <Card key={row.brand} className="gap-0 rounded-xl border py-0 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                  <div className="text-right">
                    <p className="text-[11px] text-muted-foreground">Total CIH</p>
                    <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t pt-3">
                  {BRAND_CASH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => {
                    const notSupported = col.key === 'autopay' && AUTOPAY_UNSUPPORTED_BRANDS.includes(row.brand.toUpperCase());
                    const display = cihValueDisplay(row[col.key]);
                    return (
                      <div key={col.key} className="min-w-0">
                        <p className="text-[11px] text-muted-foreground">{col.label}</p>
                        {notSupported ? (
                          <Badge variant="outline" className="mt-0.5 text-[10px] italic text-muted-foreground">Not Supported</Badge>
                        ) : (
                          <p className={`mt-0.5 text-[10.5px] font-semibold tabular-nums ${display.className}`}>{display.text}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {total && (() => {
          const totalDisplay = cihValueDisplay(total.totalBrandCIH);
          return (
            <Card className="gap-0 rounded-xl border-2 bg-muted/20 py-0 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-foreground">{total.brand}</span>
                  <div className="text-right">
                    <p className="text-[11px] text-muted-foreground">Total CIH</p>
                    <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t pt-3">
                  {BRAND_CASH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => {
                    const display = cihValueDisplay(total[col.key]);
                    return (
                      <div key={col.key} className="min-w-0">
                        <p className="text-[11px] text-muted-foreground">{col.label}</p>
                        <p className={`mt-0.5 text-[10.5px] font-bold tabular-nums ${display.className}`}>{display.text}</p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })()}
      </div>
    </Card>
  );
}

function BrandCashInhandSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden rounded-xl border py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b !py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div>
            <Skeleton className="h-[20px] w-40 rounded-md" />
            <Skeleton className="mt-1.5 h-[16px] w-56 rounded-md" />
          </div>
        </div>
        <Skeleton className="h-8 w-24 shrink-0 rounded-lg" />
      </CardHeader>
      <CardContent className="hidden overflow-x-auto p-0 sm:block">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="bg-muted/10" style={{ height: '42.5px' }}>
              <TableHead className="text-left"><Skeleton className="h-3 w-10 rounded-md" /></TableHead>
              {BRAND_CASH_COLUMNS.map((col) => (
                <TableHead key={col.key}><Skeleton className="mx-auto h-3 w-14 rounded-md" /></TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 10 }).map((_, i) => (
              <TableRow key={i} style={{ height: '44.5px' }}>
                <TableCell><Skeleton className="h-3 w-10 rounded-md" /></TableCell>
                {BRAND_CASH_COLUMNS.map((col) => (
                  <TableCell key={col.key}><Skeleton className="mx-auto h-3 w-16 rounded-md" /></TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <tfoot>
            <TableRow className="border-t-2 bg-muted/20" style={{ height: '44.5px' }}>
              <TableCell><Skeleton className="h-3 w-10 rounded-md" /></TableCell>
              {BRAND_CASH_COLUMNS.map((col) => (
                <TableCell key={col.key}><Skeleton className="mx-auto h-3 w-16 rounded-md" /></TableCell>
              ))}
            </TableRow>
          </tfoot>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function BalanceOverviewPage() {
  const [cashoutCard, setCashoutCard] = useState<CardData | null>(null);
  const [sendMoneyCard, setSendMoneyCard] = useState<CardData | null>(null);
  const [sspLine1Rows, setSspLine1Rows] = useState<SspLine1Row[]>([]);
  const [sspLine1SendMoneyRows, setSspLine1SendMoneyRows] = useState<SspLine1Row[]>([]);
  const [brandCashRows, setBrandCashRows] = useState<BrandCashRow[]>([]);
  const [brandCashTotal, setBrandCashTotal] = useState<BrandCashRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [telegramSending, setTelegramSending] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [cashoutRes, sendMoneyRes, cashGoRes, bundleRes, sspLine1Res, sspLine1SendMoneyRes, brandCashRes, agstlmRes, balRes, openingRes, estimatedRes, estimatedSendMoneyRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/sendmoney/sheet?t=${Date.now()}`),
        fetch(`/api/cashgo?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/brand-ssp-line1?t=${Date.now()}`),
        fetch(`/api/brand-ssp-line1-sendmoney?t=${Date.now()}`),
        fetch(`/api/brand-cash-inhand?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/balance-limit?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/opening/estimated-balance?t=${Date.now()}`),
        fetch(`/api/sendmoney/opening/estimated-balance?t=${Date.now()}`),
      ]);
      await assertAllOk([cashoutRes, sendMoneyRes, cashGoRes, bundleRes, sspLine1Res, sspLine1SendMoneyRes, brandCashRes, agstlmRes, balRes, openingRes, estimatedRes, estimatedSendMoneyRes]);
      const cashoutText = await cashoutRes.text();
      const sendMoneyText = await sendMoneyRes.text();
      const cashGoText = await cashGoRes.text();
      const bundleText = await bundleRes.text();
      const sspLine1Text = await sspLine1Res.text();
      const sspLine1SendMoneyText = await sspLine1SendMoneyRes.text();
      const brandCashText = await brandCashRes.text();
      const agstlmText = await agstlmRes.text();
      const balData: string[][] = await balRes.json();
      const openingText = await openingRes.text();
      const estimatedData: {
        balances: Record<string, number>;
        balancesWithFallback: Record<string, number>;
        walletTotals: Record<string, { totalDP: number; totalWD: number }>;
        uploadedAt: string | null;
      } = await estimatedRes.json();
      const estimatedSendMoneyData: {
        balances: Record<string, number>;
        balancesWithFallback: Record<string, number>;
        walletTotals: Record<string, { totalDP: number; totalWD: number }>;
        uploadedAt: string | null;
      } = await estimatedSendMoneyRes.json();

      const cashoutCutoffDate = parseCashoutReportCutoffDate(openingText);
      const estimatedUploadedAt = estimatedData.uploadedAt ? new Date(estimatedData.uploadedAt) : null;
      const estimatedOpeningValid =
        cashoutCutoffDate !== null &&
        cashoutCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedUploadedAt !== null &&
        toBusinessDate(estimatedUploadedAt).getTime() === getBusinessToday().getTime();
      const cashoutOpeningOverride = estimatedOpeningValid
        ? Object.values(estimatedData.balancesWithFallback ?? {}).reduce((sum, v) => sum + v, 0)
        : undefined;

      const sendMoneyCutoffDate = parseSendMoneyReportCutoffDate(openingText);
      const estimatedSendMoneyUploadedAt = estimatedSendMoneyData.uploadedAt ? new Date(estimatedSendMoneyData.uploadedAt) : null;
      const estimatedSendMoneyOpeningValid =
        sendMoneyCutoffDate !== null &&
        sendMoneyCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedSendMoneyUploadedAt !== null &&
        toBusinessDate(estimatedSendMoneyUploadedAt).getTime() === getBusinessToday().getTime();
      const sendMoneyOpeningOverride = estimatedSendMoneyOpeningValid
        ? Object.values(estimatedSendMoneyData.balancesWithFallback ?? {}).reduce((sum, v) => sum + v, 0)
        : undefined;

      const cutoff = getBusinessToday();
      const cashoutLiveCutoff = (cashoutCutoffDate !== null && cashoutCutoffDate.getTime() < cutoff.getTime() && !estimatedOpeningValid)
        ? cashoutCutoffDate
        : cutoff;
      const sendMoneyLiveCutoff = (sendMoneyCutoffDate !== null && sendMoneyCutoffDate.getTime() < cutoff.getTime() && !estimatedSendMoneyOpeningValid)
        ? sendMoneyCutoffDate
        : cutoff;
      const cashoutTopUpStlm = computeCashoutTopUpStlm(agstlmText, cashoutLiveCutoff);
      const sendMoneyTopUpStlm = computeSendMoneyTopUpStlm(bundleText, sendMoneyLiveCutoff);

      const todayCashGo = parseTodayCashGo(cashGoText, cashoutLiveCutoff);
      const todayBundle = parseTodayBundle(bundleText, sendMoneyLiveCutoff);

      const cashGoQuotaTotal = todayCashGo.quotaBk + todayCashGo.quotaNg;
      const cashGoQuota = cashGoQuotaTotal > 0 ? { processed: todayCashGo.bk + todayCashGo.ng, total: cashGoQuotaTotal } : null;

      const cashoutRows = parseSheetBlock(cashoutText);

      const cashoutWalletRunningBalOverride = estimatedOpeningValid
        ? (() => {
            const liveWalletTopUpStlm = computeCashoutWalletTopUpStlm(agstlmText, cutoff);
            const overrideMap = new Map<string, number>();
            Object.entries(estimatedData.walletTotals ?? {}).forEach(([wallet, uploaded]) => {
              const dashboardRow = cashoutRows.find((r) => r.wallet.toUpperCase() === wallet);
              const dashboardRunningBal = dashboardRow?.runningBal ?? 0;
              const live = liveWalletTopUpStlm.get(wallet) ?? { topUp: 0, stlm: 0 };
              const assumedRunningBal = dashboardRunningBal - live.stlm + live.topUp - uploaded.totalWD + uploaded.totalDP;
              overrideMap.set(wallet, assumedRunningBal);
            });
            return overrideMap;
          })()
        : undefined;

      const sendMoneyRows = parseSheetBlock(sendMoneyText);

      const sendMoneyWalletRunningBalOverride = estimatedSendMoneyOpeningValid
        ? (() => {
            const liveWalletTopUpStlm = computeSendMoneyWalletTopUpStlm(bundleText, cutoff);
            const overrideMap = new Map<string, number>();
            Object.entries(estimatedSendMoneyData.walletTotals ?? {}).forEach(([wallet, uploaded]) => {
              const dashboardRow = sendMoneyRows.find((r) => r.wallet.toUpperCase() === wallet);
              const dashboardRunningBal = dashboardRow?.runningBal ?? 0;
              const live = liveWalletTopUpStlm.get(wallet) ?? { topUp: 0, stlm: 0 };
              const assumedRunningBal = dashboardRunningBal - live.stlm + live.topUp - uploaded.totalWD + uploaded.totalDP;
              overrideMap.set(wallet, assumedRunningBal);
            });
            return overrideMap;
          })()
        : undefined;

      setCashoutCard(buildCardData(cashoutRows, 'cashout', 'Cashout', 'CashGo', [
        { key: 'bk', label: 'Bkash', value: todayCashGo.bk, quota: todayCashGo.quotaBk },
        { key: 'ng', label: 'Nagad', value: todayCashGo.ng, quota: todayCashGo.quotaNg },
      ], cashGoQuota, cashoutTopUpStlm, cashoutOpeningOverride, cashoutWalletRunningBalOverride));
      setSendMoneyCard(buildCardData(sendMoneyRows, 'sendmoney', 'Send Money', 'Bundle Transfer', [
        { key: 'nagad', label: 'Nagad', value: todayBundle.nagad },
        { key: 'rocket', label: 'Rocket', value: todayBundle.rocket },
        { key: 'upay', label: 'UPay', value: todayBundle.upay },
      ], null, sendMoneyTopUpStlm, sendMoneyOpeningOverride, sendMoneyWalletRunningBalOverride));

      const sspLine1BrandGroups = new Map<string, string[]>();
      balData.slice(1).forEach((row) => {
        const walletName = (row[1] ?? '').trim();
        const group = (row[6] ?? '').trim();
        if (!walletName || walletName === '-' || !group || group === '-') return;
        const groups = sspLine1BrandGroups.get(walletName) ?? [];
        groups.push(group);
        sspLine1BrandGroups.set(walletName, groups);
      });
      const sspLine1BrandTopUpStlm = computeCashoutBrandTopUpStlm(agstlmText, cutoff, sspLine1BrandGroups);

      setSspLine1Rows(
        parseSspLine1(sspLine1Text).map((row) => {
          const brandTotals = sspLine1BrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
          return { ...row, topUp: brandTotals.topUp, settlement: -brandTotals.stlm };
        })
      );

      const sspLine1SendMoneyBrandTopUpStlm = computeSendMoneyBrandTopUpStlm(bundleText, cutoff);
      setSspLine1SendMoneyRows(
        parseSspLine1(sspLine1SendMoneyText).map((row) => {
          const brandTotals = sspLine1SendMoneyBrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
          return { ...row, topUp: brandTotals.topUp, settlement: -brandTotals.stlm };
        })
      );

      const brandCash = parseBrandCashInhand(brandCashText);
      setBrandCashRows(brandCash.rows);
      setBrandCashTotal(brandCash.total);
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

  // Sends both cards (Cashout + Send Money) and the Brand Balance table as
  // two photos in a single Telegram album — one trigger, one message, both
  // images.
  const handleSendToTelegram = async () => {
    setTelegramSending(true);
    try {
      const res = await fetch('/api/telegram/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/balance-overview',
          label: 'Brand Balance | CashOut & SendMoney',
          captures: ['[data-telegram-capture="cards"]', '[data-telegram-capture="brand"]'],
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Failed to send screenshot.');
      }
      setToast({ type: 'success', message: 'Sent to Telegram.' });
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to send screenshot.' });
    } finally {
      setTelegramSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      <header className="sticky top-0 z-30 border-b bg-background/95 py-0 pl-14 pr-4 backdrop-blur-sm md:px-8">
        <div className="flex h-12 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-primary" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">Balance Overview</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={handleSendToTelegram}
              disabled={telegramSending || loading}
              aria-label="Send to Telegram"
              title="Send to Telegram"
              className="h-8 w-8"
            >
              <Send size={13} className={telegramSending ? 'animate-spin' : ''} />
            </Button>
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={fetchData} disabled={spinning} aria-label="Refresh" title="Refresh">
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>
      </header>
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        {loading && (
          <>
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CardSkeleton />
              <CardSkeleton />
            </section>
            <SspLine1Skeleton />
            <SspLine1Skeleton />
            <BrandCashInhandSkeleton />
          </>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && cashoutCard && sendMoneyCard && (
          <section data-telegram-capture="cards" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BalanceCard data={cashoutCard} />
            <BalanceCard data={sendMoneyCard} />
          </section>
        )}

        {!loading && !error && (
          <SspLine1Section
            rows={sspLine1Rows}
            title="SSP Line 1: Cashout"
            subtitle="Smart Solution Running Balance by Brand"
            exportFileName="SSP_LINE1_AGENT_CASHOUT"
            exportSheetName="SSP Line 1 Cashout"
          />
        )}

        {!loading && !error && (
          <SspLine1Section
            rows={sspLine1SendMoneyRows}
            title="SSP Line 2: Send Money"
            subtitle="Smart Solution Running Balance by Brand"
            exportFileName="SSP_LINE1_SENDMONEY"
            exportSheetName="SSP Line 1 Send Money"
          />
        )}

        {!loading && !error && (
          <BrandCashInhandSection rows={brandCashRows} total={brandCashTotal} />
        )}
      </main>
    </div>
  );
}
