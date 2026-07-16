'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Image from 'next/image';
import * as XLSX from 'xlsx';
import { RefreshCw, ArrowLeftRight, Wallet, Banknote, Building2, Download, Send, ChevronUp, ChevronDown } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import ConnectionErrorState from '../components/ConnectionErrorState';
import Toast, { type ToastState } from '../components/Toast';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { getBusinessToday, toBusinessDate, parseCardCutoffDate } from '../lib/businessDate';

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

// "Brand Balance" sheet writes negative cash-in-hand in accounting format,
// e.g. "(1,137,336.19)", and a bare "-" for zero — neither parses correctly
// through clean()'s plain parseFloat.
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

// Drops a trailing ".00" (e.g. "20.00M" -> "20M") — only used for the Today
// strip's quota figure, not fmtAbbrev's other call sites on this page.
function fmtAbbrevTrimmed(num: number): string {
  return fmtAbbrev(num).replace(/\.00(?=[A-Z]|$)/, '');
}

// 1 decimal below 100 (e.g. "99.7%"), clamped to a flat "100%" only once the
// quota is actually met or exceeded — never rounds up to "100%" early.
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
// Filenames match the actual case on disk — the VPS deploy target is Linux,
// where paths are case-sensitive, so this must match exactly (not the
// lowercase convention used in the rest of this file).
const WALLET_LOGOS: Record<string, string> = {
  BKASH: '/wallets/Bkash.png',
  NAGAD: '/wallets/Nagad.png',
  ROCKET: '/wallets/Rocket.png',
  UPAY: '/wallets/Upay.png',
};
// Brand-adjacent colors for the circle+initial fallback, used if a logo file
// is missing or fails to load.
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

// "Dashboard Overview" sheet block, per row: Wallet, Total DP, Total WD(/PayOut),
// BD-Transfer IN, STLM & BD Transfer Out, Balance Inside Wallet, Running Bal.,
// Opening Balance. BD-Transfer IN and STLM & BD Transfer Out are each already
// signed correctly in the raw sheet (IN positive, OUT negative) — confirmed by
// reconciling opening + totalDP - totalWD + bdTransferIn + stlmOut against the
// sheet's own Running Bal. column on real data, which matched exactly.
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

// "CashGo" sheet dates are formatted "June 1" (no year) — same parsing as
// app/page.tsx's CashGo Trend, this page's Today strip source for CashOut.
function parseCashGoDate(raw: string): Date | null {
  const match = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = parseInt(match[2], 10);
  return new Date(new Date().getFullYear(), monthIndex, day);
}

// /api/cashgo cols: [1]=date ("June 1"), [2]=Bkash quota, [3]=Nagad quota,
// [4]=Bkash processed, [5]=Nagad processed.
function parseTodayCashGo(text: string): { bk: number; ng: number; quotaBk: number; quotaNg: number } {
  const now = getBusinessToday();
  const lines = text.trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const date = parseCashGoDate((cols[1] ?? '').replace(/"/g, '').trim());
    if (date && date.toDateString() === now.toDateString()) {
      return { bk: clean(cols[4]), ng: clean(cols[5]), quotaBk: clean(cols[2]), quotaNg: clean(cols[3]) };
    }
  }
  return { bk: 0, ng: 0, quotaBk: 0, quotaNg: 0 };
}

// "AG BD STLM + TOPUP" / "PS BD STLM + TOPUP" dates are "M/D/YYYY" — same
// parsing as app/sendmoney/page.tsx's Bundle Transfer Trend.
function parseSlashDate(raw: string): Date | null {
  const parts = (raw ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

// /api/sendmoney/stlmtopup cols H-L (idx 7-11) hold this month's Settlement
// rows; cols W-AA (idx 22-26) hold last month's archive, same field order
// shifted +15 — both are unioned same as the Bundle Transfer Trend chart.
// Amounts are stored negative; displayed as abs().
function parseTodayBundle(text: string): { nagad: number; rocket: number; upay: number } {
  const now = getBusinessToday();
  const totals = { nagad: 0, rocket: 0, upay: 0 };
  const addRow = (nameRaw: string, amountRaw: string, dateRaw: string, walletRaw: string, typeRaw: string) => {
    const type = (typeRaw ?? '').replace(/"/g, '').trim().toUpperCase();
    if (type !== 'BUNDLE TRANSFER') return;
    const name = (nameRaw ?? '').replace(/"/g, '').trim();
    if (!name || name === '-') return;
    const amount = Math.abs(clean(amountRaw));
    if (!amount) return;
    const date = parseSlashDate((dateRaw ?? '').replace(/"/g, '').trim());
    if (!date || date.toDateString() !== now.toDateString()) return;
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

// "Opening AG" sheet col G — Cashout's own "REPORT LAST UPDATE" card, e.g.
// "July 14 - 8:45 AM". Used only to detect whether Opening AG has been
// manually refreshed for today yet (Estimated Opening validity check) —
// NOT for Top Up/Settlement gating, which is purely clock-based (see
// computeCashoutTopUpStlm/computeSendMoneyTopUpStlm below).
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

// "Opening AG" sheet col I — Send Money's own "UPDATED TIME" card, side by
// side with Cashout's own card in col G above (confirmed by the user, not
// shared). Same validity-check purpose as parseCashoutReportCutoffDate.
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

// The "Dashboard Overview" sheet's own BD-Transfer IN / STLM columns are
// always seeded at 0 (never manually updated) — Cashout/Send Money's own
// Overview pages don't trust them either, patching in live totals from "AG/PS
// BD STLM + TOPUP" instead. Mirrors app/page.tsx's exact same computation
// (Top Up cols B-F idx 1-5 positive; Settlement cols H-L idx 7-11 stored
// negative, abs()'d for magnitude then re-signed negative for display) so
// this total matches Cashout Overview's own Wallet Summary Total row.
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

// Same source/cutoff as computeCashoutTopUpStlm, but grouped by wallet type
// (Bkash/Nagad/Rocket/Upay — col[4] for Top Up, col[10] for Settlement, same
// column layout app/page.tsx's own Wallet Summary table already uses)
// instead of summed into one grand total — feeds Balance Overview's Wallet
// Breakdown Assumed Running Balance.
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

// Brand resolution — same logic as app/agentbal/page.tsx's own
// computeBrand/resolveBrand (duplicated page-locally per this codebase's
// convention, not shared): a shop's brand is the majority "Group" value
// (from "SSP AG BalanceLimit"'s own Group column) across its wallet rows,
// ties broken by BRAND_PRIORITY, falling back to a brand code embedded in
// the agent name itself if no group data exists at all.
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

// "To Agent" values on "AG BD STLM + TOPUP" sometimes carry a trailing
// "-<brand>" suffix (e.g. "KONAN001-M1"), sometimes not — strip it so the
// bare code matches "SSP AG BalanceLimit"'s own wallet-name keys.
function stripSspLine1BrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && SSP_LINE1_BRAND_PRIORITY.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// Same source/cutoff as computeCashoutTopUpStlm, but grouped by resolved
// Brand (M1/M2/K1/B1-B5/T1/J1) instead of summed into one grand total —
// feeds the SSP Line 1 table's Top Up/Settlement columns. brandGroups maps
// a bare shop/wallet name (from "SSP AG BalanceLimit") to its own list of
// raw Group values, same map shape app/agentbal/page.tsx already builds.
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

// Mirrors app/sendmoney/page.tsx's own wallet-type patch — Settlement's raw
// sign is negative in the sheet, so it's abs()'d for magnitude then
// re-signed negative at the end, same convention as Cashout and Send
// Money's own /balances page (a missing abs() here previously double-
// negated Settlement to a wrong positive sign; fixed in both places).
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

// Same source/cutoff/column layout as computeSendMoneyTopUpStlm, but grouped
// by wallet type (col[4] for Top Up, col[10] for Settlement — identical
// column positions to computeCashoutWalletTopUpStlm's own agstlm sheet, only
// the Type labels are swapped between the two products) instead of summed
// into one grand total — feeds Send Money's own Wallet Breakdown Assumed
// Running Balance.
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

// Send Money's own brand resolution — unlike Cashout's (which cross-
// references "SSP AG BalanceLimit"'s Group column), Send Money's brand is
// embedded directly in the wallet name itself, e.g. "D-B2BD-DELTA073-NG" ->
// segment "B2BD" -> "B2" — same convention already used by
// app/sendmoney/settlement/page.tsx and app/sendmoney/topup/page.tsx (and
// app/lib/sendMoneyOpening.ts). Includes 'SH' (Sharing), a brand Cashout's
// own roster doesn't have.
const SSP_LINE1_SENDMONEY_BRAND_CODES = [...SSP_LINE1_BRAND_PRIORITY, 'SH'];

function resolveSendMoneyBrandFromWalletName(walletName: string): string {
  const segment = (walletName.split('-')[1] ?? '').toUpperCase();
  const code = SSP_LINE1_SENDMONEY_BRAND_CODES.find((c) => segment.startsWith(c));
  return code ?? '−';
}

// Same source/cutoff/column layout as computeSendMoneyTopUpStlm, but grouped
// by resolved Brand instead of summed into one grand total — feeds Send
// Money's own SSP Line 1 table's Top Up/Settlement columns. No cross-sheet
// lookup needed here (unlike Cashout's computeCashoutBrandTopUpStlm) since
// the wallet name itself carries the brand.
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

// "Brand Balance!B3:G13": row 0 is the header (Brand, Opening Balance,
// Deposit, Withdrawal, Adjustment, Total), rows 1-10 are one row per brand
// (M1/M2/K1/B1-B5/T1/J1) — no footer row. Column D (Adjustment, index 4) is
// intentionally not read — replaced by live per-brand Top Up/Settlement
// (see computeCashoutBrandTopUpStlm below), merged in by the caller.
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

// "Brand Balance!B28:H40": row 0 is the header, the last row is the
// "Total PG CIH" column-totals footer, everything between is one row per brand.
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
  // Per-wallet quota (CashGo only) — when present, the wallet chip shows
  // "value/quota" instead of a bare value. Bundle Transfer has no quota
  // concept, so it's left undefined there.
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
  // CashGo-only: today's combined Bkash+Nagad quota vs. processed, as one
  // overall figure, not per wallet. Bundle Transfer has no quota concept,
  // so this is null there.
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
  // Once the 2AM business-day rollover has happened and a fresh "Estimated
  // Opening" upload is on file (see app/lib/estimatedOpening.ts), Opening
  // Balance comes from there instead of the "Dashboard Overview" sheet's own
  // (not-yet-updated-for-today) seed value.
  const opening = openingOverride ?? total?.opening ?? 0;
  // Always the real figures, always included in Ending below — the user
  // owns keeping this sheet's own Deposit/Withdrawal cells from overlapping
  // with whatever's baked into an active Estimated Opening upload; the code
  // doesn't assume or exclude anything here.
  const deposit = total?.totalDP ?? 0;
  const withdrawal = total?.totalWD ?? 0;
  // The sheet's own BD-Transfer IN / STLM columns are always seeded at 0 —
  // computeCashoutTopUpStlm/computeSendMoneyTopUpStlm above patch in live
  // totals instead, same as Cashout/Send Money's own Overview pages already do.
  // EXCEPT while the Assumed Balance override is active: the assumed Opening
  // figure was itself computed as (live Opening + uploaded DP/WD + today's
  // live Top Up/Settlement), so today's Top Up/Settlement are already baked
  // into `opening` above — showing them again here would double-count them.
  // Zeroed instead of live-patched until the real Opening Balance actually
  // refreshes and this override stops applying on its own.
  const bdTransferIn = openingOverride !== undefined ? 0 : topUpStlm.topUp;
  const stlmOut = openingOverride !== undefined ? 0 : topUpStlm.stlm;
  // Both already signed (IN positive, OUT negative), so Adjustment's net
  // effect on Ending Balance is a straight sum, not a subtraction.
  const ending = opening + deposit - withdrawal + bdTransferIn + stlmOut;

  const wallets: CardWallet[] = WALLET_ORDER.map((key) => {
    const row = rows.find((r) => r.wallet.toUpperCase() === key);
    // Same Assumed-Balance override as the card's own Opening Balance above,
    // applied per wallet (Bkash/Nagad/Rocket/Upay) instead of the aggregate.
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

// Zero is neutral, not a "movement" — no +/- sign, no emerald/rose tint.
function flowValueDisplay(num: number): { text: string; colorClass: string } {
  if (Math.abs(num) < 0.005) {
    return { text: fmt(num), colorClass: 'text-foreground' };
  }
  return {
    text: `${num >= 0 ? '+' : '−'}${fmt(num)}`,
    colorClass: num >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
  };
}

function FlowRow({ label, value, valueClass, last }: { label: string; value: string; valueClass?: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2.5 ${last ? '' : 'border-b border-border'}`}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={`text-[13px] font-semibold tabular-nums ${valueClass ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function WalletTile({ wallet }: { wallet: CardWallet }) {
  const name = WALLET_DISPLAY_NAMES[wallet.wallet] ?? wallet.wallet;

  if (wallet.comingSoon) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted/50 hover:shadow-md">
        <div className="flex items-center gap-1.5">
          <WalletLogo wallet={wallet.wallet} muted />
          <span className="text-[13px] text-muted-foreground">{name}</span>
        </div>
        <p className="mt-2 text-[14px] font-medium text-muted-foreground">Coming soon</p>
      </div>
    );
  }

  const up = wallet.delta >= 0;
  return (
    <div className="rounded-xl border border-border bg-white px-3 py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted/50 hover:shadow-md dark:bg-[#2a2a2d]">
      <div className="flex items-center gap-1.5">
        <WalletLogo wallet={wallet.wallet} />
        <span className="text-[13px] text-muted-foreground">{name}</span>
      </div>
      <p className="mt-1.5 text-[17px] font-bold tabular-nums text-foreground">{fmtAbbrev(wallet.runningBal)}</p>
      <p className={`mt-0.5 text-[12px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
        {up ? '▴' : '▾'} {fmtAbbrev(wallet.delta)}
      </p>
      <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5">
        <span className="text-[11px] text-muted-foreground">Actual Balance</span>
        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{fmtAbbrev(wallet.actualBal)}</span>
      </div>
    </div>
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
          <div className="mt-2.5 h-[6px] w-full overflow-hidden rounded-full border border-border bg-muted">
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
    <div data-product={data.product} className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="p-5">
        <h3 className="mb-4 inline-flex items-center gap-1.5 border-b-2 pb-1 text-[15px] font-semibold text-foreground" style={{ borderColor: 'var(--product-accent)' }}>
          {data.product === 'cashout' ? (
            <Wallet size={14} style={{ color: 'var(--product-accent)' }} />
          ) : (
            <Banknote size={14} style={{ color: 'var(--product-accent)' }} />
          )}
          {data.productLabel}
        </h3>

        <div>
          <FlowRow label="Opening Balance" value={fmt(data.opening)} />
          <FlowRow label="Deposit" value={`+${fmt(data.deposit)}`} valueClass="text-emerald-600 dark:text-emerald-400" />
          <FlowRow label="Withdrawal" value={`−${fmt(data.withdrawal)}`} valueClass="text-rose-600 dark:text-rose-400" />
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
      </div>
    </div>
  );
}

// Heights below are measured directly from the real, loaded card via a
// headless-browser geometry dump (not eyeballed) — see git history for the
// measurement script. Keep in sync if BalanceCard's structure changes.
function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="p-5">
        <div className="mb-4 h-[28px] w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
        <div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`flex items-center justify-between py-2.5 ${i < 4 ? 'border-b border-border' : ''}`}>
              <div className="h-[20px] w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
              <div className="h-[20px] w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            </div>
          ))}
        </div>
        <div className="mt-3 h-[71px] animate-pulse rounded-[10px] bg-slate-100 dark:bg-slate-800" />
        <div className="mt-3 h-[93px] animate-pulse rounded-[10px] bg-slate-100 dark:bg-slate-800" />
        <div className="mb-3 mt-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <div className="h-[18px] w-28 shrink-0 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
          <div className="h-px flex-1 bg-border" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[123px] animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
          ))}
        </div>
      </div>
    </div>
  );
}

const BRAND_CASH_COLUMNS: { key: keyof Omit<BrandCashRow, 'brand'>; label: string }[] = [
  { key: 'sspAg', label: 'CashOut' },
  { key: 'sspPs', label: 'SendMoney' },
  { key: 'ess', label: 'ESS' },
  { key: 'autopay', label: 'Autopay' },
  { key: 'expay', label: 'Expay' },
  { key: 'totalBrandCIH', label: 'Total CIH' },
];

// These brands don't support Autopay as a payment gateway at all — the
// sheet shows 0 for them, but that reads as a real zero balance rather than
// "not applicable", so the Autopay column overrides to an explicit label
// for just these rows. The footer's Autopay total is unaffected (it's a
// genuine sum across the brands that do support it).
const AUTOPAY_UNSUPPORTED_BRANDS = ['B3', 'B4', 'B5', 'J1', 'T1'];

function cihValueDisplay(value: number): { text: string; className: string } {
  const zero = Math.abs(value) < 0.005;
  const negative = value < 0;
  return {
    text: zero ? '−' : `${negative ? '−' : ''}${fmt(value)}`,
    className: zero ? 'text-muted-foreground' : negative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
  };
}

function CihCell({ value, bold }: { value: number; bold?: boolean }) {
  const display = cihValueDisplay(value);
  return (
    <td className={`whitespace-nowrap px-4 py-3 text-center text-[13px] tabular-nums ${bold ? 'font-bold' : 'font-medium'} ${display.className}`}>
      {display.text}
    </td>
  );
}

function NotSupportedCell() {
  return (
    <td className="whitespace-nowrap px-4 py-3 text-center text-[13px] font-medium italic text-muted-foreground">
      Not Supported
    </td>
  );
}

const SSP_LINE1_COLUMNS: { key: keyof Omit<SspLine1Row, 'brand'>; label: string }[] = [
  { key: 'opening', label: 'Opening Balance' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'withdrawal', label: 'Withdrawal' },
  { key: 'topUp', label: 'Top Up' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'total', label: 'Total' },
];

// Same container/table/mobile-card format as BrandCashInhandSection below —
// this section just ships first, per explicit instruction ("mauuna muna to
// bago yung Brand Balance"). No footer row (unlike Brand Cash Inhand's
// "Total PG CIH" row) since the confirmed sheet range (B3:G13) has none.
type SspLine1SortKey = keyof SspLine1Row;

// Chevron pair when idle, single filled chevron when this column is the
// active sort — same visual convention as the sort arrows used elsewhere in
// the app (e.g. app/agentbal/page.tsx's own SortIcon).
function SspLine1SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={12} className="text-indigo-600 dark:text-indigo-400" />
  ) : (
    <ChevronDown size={12} className="text-indigo-600 dark:text-indigo-400" />
  );
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
  // No default sort ("default walang naka filter") — first click on a
  // column sorts highest-to-lowest (desc), second click toggles to
  // lowest-to-highest (asc), third click returns to the unsorted default.
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

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, exportSheetName);

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `${exportFileName}_${datePart}_${timePart}.xlsx`);
  }, [rows, exportFileName, exportSheetName]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-white dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Wallet size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-foreground">{title}</h2>
            <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[14px] font-medium text-white hover:bg-indigo-700"
        >
          <Download size={13} />
          Export
        </button>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold text-muted-foreground">
                <button
                  type="button"
                  onClick={() => handleHeaderClick('brand')}
                  className="flex items-center gap-1 hover:opacity-80"
                >
                  Brand
                  <SspLine1SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </th>
              {SSP_LINE1_COLUMNS.map((col) => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-center text-[12px] font-semibold text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => handleHeaderClick(col.key)}
                    className="flex w-full items-center justify-center gap-1 hover:opacity-80"
                  >
                    {col.label}
                    <SspLine1SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.brand} className="border-b border-border last:border-0 transition-colors hover:bg-muted/10">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[13px] font-semibold text-foreground">{row.brand}</td>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <CihCell key={col.key} value={row[col.key]} bold={col.key === 'total'} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per brand — same "card list" pattern as Brand
          Cash Inhand's own mobile fallback. */}
      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.map((row) => {
          const totalDisplay = cihValueDisplay(row.total);
          return (
            <div key={row.brand} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
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
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Mirrors the real table's own markup/padding (10 brand rows + header, no
// footer) instead of a handful of generic placeholder lines — a shorter
// fake table would cause a visible size jump when the real table pops in.
function SspLine1Skeleton() {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-white dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
          <div>
            <div className="h-[20px] w-48 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            <div className="mt-1.5 h-[16px] w-64 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
          </div>
        </div>
        <div className="h-8 w-24 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10" style={{ height: '42.5px' }}>
              <th className="px-4 py-3 text-left">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </th>
              {SSP_LINE1_COLUMNS.map((col) => (
                <th key={col.key} className="px-4 py-3">
                  <div className="mx-auto h-3 w-14 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0" style={{ height: '44.5px' }}>
                <td className="px-4 py-3">
                  <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                </td>
                {SSP_LINE1_COLUMNS.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]" style={{ height: '184px' }}>
            <div className="flex items-start justify-between gap-2">
              <div className="h-[18px] w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                <div className="h-[22px] w-24 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 border-t border-border pt-3">
              {Array.from({ length: 4 }).map((__, j) => (
                <div key={j} className="min-w-0">
                  <div className="h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  <div className="mt-1.5 h-3 w-14 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type BrandCashSortKey = keyof BrandCashRow;

function BrandCashInhandSection({ rows, total }: { rows: BrandCashRow[]; total: BrandCashRow | null }) {
  // No default sort, same 3-click cycle (desc -> asc -> unsorted) as the SSP
  // Line 1/2 tables above. The footer Total row is never part of the sort —
  // it always stays pinned at the bottom as a fixed summary.
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

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Brand Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `BRAND_BALANCE_${datePart}_${timePart}.xlsx`);
  }, [rows, total]);

  return (
    <section data-telegram-capture="brand" className="overflow-hidden rounded-xl border border-border bg-white dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Building2 size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-foreground">Brand Balance</h2>
            <p className="truncate text-[13px] text-muted-foreground">Summary of cash in hand by brand and payment gateway</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[14px] font-medium text-white hover:bg-indigo-700"
        >
          <Download size={13} />
          Export
        </button>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold text-muted-foreground">
                <button
                  type="button"
                  onClick={() => handleHeaderClick('brand')}
                  className="flex items-center gap-1 hover:opacity-80"
                >
                  Brand
                  <SspLine1SortIcon active={sortColumn === 'brand'} direction={sortDirection} />
                </button>
              </th>
              {BRAND_CASH_COLUMNS.map((col) => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-center text-[12px] font-semibold text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => handleHeaderClick(col.key)}
                    className="flex w-full items-center justify-center gap-1 hover:opacity-80"
                  >
                    {col.label}
                    <SspLine1SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.brand} className="border-b border-border last:border-0 transition-colors hover:bg-muted/10">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[13px] font-semibold text-foreground">{row.brand}</td>
                {BRAND_CASH_COLUMNS.map((col) =>
                  col.key === 'autopay' && AUTOPAY_UNSUPPORTED_BRANDS.includes(row.brand.toUpperCase()) ? (
                    <NotSupportedCell key={col.key} />
                  ) : (
                    <CihCell key={col.key} value={row[col.key]} bold={col.key === 'totalBrandCIH'} />
                  )
                )}
              </tr>
            ))}
          </tbody>
          {total && (
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/20">
                <td className="whitespace-nowrap px-4 py-3 text-left text-[13px] font-bold text-foreground">{total.brand}</td>
                {BRAND_CASH_COLUMNS.map((col) => (
                  <CihCell key={col.key} value={total[col.key]} bold />
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile: one card per brand — the 7-column table forces horizontal
          scroll on narrow screens, same "card list" pattern already used for
          Wallet Summary tables elsewhere in the app. */}
      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {sortedRows.map((row) => {
          const totalDisplay = cihValueDisplay(row.totalBrandCIH);
          return (
            <div key={row.brand} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{row.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total CIH</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
                {BRAND_CASH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => {
                  const notSupported = col.key === 'autopay' && AUTOPAY_UNSUPPORTED_BRANDS.includes(row.brand.toUpperCase());
                  const display = cihValueDisplay(row[col.key]);
                  return (
                    <div key={col.key} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{col.label}</p>
                      {notSupported ? (
                        <p className="mt-0.5 text-[10.5px] font-semibold italic text-muted-foreground">Not Supported</p>
                      ) : (
                        <p className={`mt-0.5 text-[10.5px] font-semibold tabular-nums ${display.className}`}>{display.text}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {total && (() => {
          const totalDisplay = cihValueDisplay(total.totalBrandCIH);
          return (
            <div className="rounded-xl border-2 border-border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[15px] font-bold text-foreground">{total.brand}</span>
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">Total CIH</p>
                  <p className={`text-lg font-bold tabular-nums ${totalDisplay.className}`}>{totalDisplay.text}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
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
            </div>
          );
        })()}
      </div>
    </section>
  );
}

// Mirrors the real table's own <table>/<thead>/<tbody>/<tfoot> markup and
// padding (same 10 brand rows + header + footer as the live sheet) instead
// of a handful of generic placeholder lines — a shorter fake table was
// causing a visible size jump when the real ~600px-tall table popped in.
function BrandCashInhandSkeleton() {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-white dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
          <div>
            <div className="h-[20px] w-40 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            <div className="mt-1.5 h-[16px] w-56 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
          </div>
        </div>
        <div className="h-8 w-24 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10" style={{ height: '42.5px' }}>
              <th className="px-4 py-3 text-left">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </th>
              {BRAND_CASH_COLUMNS.map((col) => (
                <th key={col.key} className="px-4 py-3">
                  <div className="mx-auto h-3 w-14 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0" style={{ height: '44.5px' }}>
                <td className="px-4 py-3">
                  <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                </td>
                {BRAND_CASH_COLUMNS.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/20" style={{ height: '44.5px' }}>
              <td className="px-4 py-3">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </td>
              {BRAND_CASH_COLUMNS.map((col) => (
                <td key={col.key} className="px-4 py-3">
                  <div className="mx-auto h-3 w-16 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile skeleton — mirrors the real card list's own height (184px per
          brand card, 186px for the bordered Total card) so nothing jumps in
          size once live data replaces this. */}
      <div className="flex flex-col gap-3 p-4 sm:hidden">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-white p-4 dark:bg-[#2a2a2d]" style={{ height: '184px' }}>
            <div className="flex items-start justify-between gap-2">
              <div className="h-[18px] w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                <div className="h-[22px] w-24 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
              {BRAND_CASH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => (
                <div key={col.key} className="min-w-0">
                  <div className="h-3 w-10 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  <div className="mt-1 h-3 w-14 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="rounded-xl border-2 border-border bg-muted/20 p-4" style={{ height: '186px' }}>
          <div className="flex items-start justify-between gap-2">
            <div className="h-[18px] w-20 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
            <div className="flex flex-col items-end gap-1.5">
              <div className="h-3 w-16 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              <div className="h-[22px] w-24 animate-pulse rounded-md bg-slate-400 dark:bg-slate-500" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 border-t border-border pt-3">
            {BRAND_CASH_COLUMNS.filter((col) => col.key !== 'totalBrandCIH').map((col) => (
              <div key={col.key} className="min-w-0">
                <div className="h-3 w-10 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
                <div className="mt-1 h-3 w-14 animate-pulse rounded-md bg-slate-300 dark:bg-slate-600" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
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
        walletTotals: Record<string, { totalDP: number; totalWD: number }>;
        uploadedAt: string | null;
      } = await estimatedRes.json();
      const estimatedSendMoneyData: {
        balances: Record<string, number>;
        balancesWithFallback: Record<string, number>;
        walletTotals: Record<string, { totalDP: number; totalWD: number }>;
        uploadedAt: string | null;
      } = await estimatedSendMoneyRes.json();

      const todayCashGo = parseTodayCashGo(cashGoText);
      const todayBundle = parseTodayBundle(bundleText);

      // Overall (not per-wallet) today's combined quota vs. processed —
      // Bundle Transfer has no quota concept, so it's null there.
      const cashGoQuotaTotal = todayCashGo.quotaBk + todayCashGo.quotaNg;
      const cashGoQuota = cashGoQuotaTotal > 0 ? { processed: todayCashGo.bk + todayCashGo.ng, total: cashGoQuotaTotal } : null;

      // Top Up/Settlement totals reset at the 2AM business-day rollover (see
      // app/lib/businessDate.ts) — clock-based, not gated on whether
      // Opening's own "Updated Time" card has been manually refreshed yet.
      const cutoff = getBusinessToday();
      const cashoutTopUpStlm = computeCashoutTopUpStlm(agstlmText, cutoff);
      const sendMoneyTopUpStlm = computeSendMoneyTopUpStlm(bundleText, cutoff);

      // Cashout's Opening Balance card figure switches to the sum of
      // "Estimated Opening" (Assumed Balance) once BOTH hold — same rule as
      // the Balance tab (app/agentbal/page.tsx):
      // 1. Opening AG's own "Updated Time" card is still showing the
      //    PREVIOUS business day (the real reset for today hasn't happened).
      // 2. The upload's own "Last Updated" timestamp is itself from TODAY's
      //    business day (a stale, un-refreshed upload must not keep being
      //    used just because Opening's own reset is also running late).
      // Otherwise it falls back to the "Dashboard Overview" sheet's own
      // Opening figure, unchanged.
      const cashoutCutoffDate = parseCashoutReportCutoffDate(openingText);
      const estimatedUploadedAt = estimatedData.uploadedAt ? new Date(estimatedData.uploadedAt) : null;
      const estimatedOpeningValid =
        cashoutCutoffDate !== null &&
        cashoutCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedUploadedAt !== null &&
        toBusinessDate(estimatedUploadedAt).getTime() === getBusinessToday().getTime();
      const cashoutOpeningOverride = estimatedOpeningValid
        ? Object.values(estimatedData.balances ?? {}).reduce((sum, v) => sum + v, 0)
        : undefined;

      const cashoutRows = parseSheetBlock(cashoutText);

      // Same validity gate as the Opening Balance override above, applied
      // per wallet (Bkash/Nagad/Rocket/Upay) for the Wallet Breakdown tiles:
      //   Assumed Running Balance = Dashboard Running Balance − Settlement
      //     (live) + Top Up (live) − Uploaded Total WD + Uploaded Total DP
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

      // Send Money's own Opening Balance card figure — same rule as
      // Cashout's above, except the validity check is based on col I's
      // "UPDATED TIME" card (Send Money's own) instead of col G's.
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

      const sendMoneyRows = parseSheetBlock(sendMoneyText);

      // Same validity gate as the Opening Balance override above, applied
      // per wallet (Nagad/Rocket/Upay) for Send Money's own Wallet
      // Breakdown tiles.
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

      // "SSP AG BalanceLimit" -> wallet name (col 1) + its own Group (col 6),
      // same shape app/agentbal/page.tsx builds for its own brand resolution.
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

      // Send Money's own SSP Line 1 table — same logic, sourced from "PS BD
      // STLM + TOPUP" (bundleText) with Send Money's own wallet-name-based
      // brand resolution (no cross-sheet lookup needed).
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
  // images — rather than the two separate per-dashboard "Send to Telegram"
  // buttons this replaces.
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
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="sticky top-0 z-30 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-indigo-500" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">Balance Overview</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleSendToTelegram}
              disabled={telegramSending || loading}
              aria-label="Send to Telegram"
              title="Send to Telegram"
              className="flex items-center justify-center rounded-lg border border-border bg-muted/60 p-1.5 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={13} className={telegramSending ? 'animate-spin' : ''} />
            </button>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning}
              aria-label="Refresh"
              title="Refresh"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            </button>
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

        {/* Future Balance Overview sections append below this line */}
      </main>
    </div>
  );
}
