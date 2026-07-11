'use client';

import { useEffect, useState, useCallback } from 'react';
import Image from 'next/image';
import * as XLSX from 'xlsx';
import { RefreshCw, ArrowLeftRight, Wallet, Banknote, Building2, Download, Send } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import ConnectionErrorState from '../components/ConnectionErrorState';
import Toast, { type ToastState } from '../components/Toast';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';

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
  const now = new Date();
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
  const now = new Date();
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
  todayQuota: TodayQuota | null
): CardData {
  const total = rows.find((r) => r.wallet.toUpperCase() === 'TOTAL');
  const opening = total?.opening ?? 0;
  const deposit = total?.totalDP ?? 0;
  const withdrawal = total?.totalWD ?? 0;
  const bdTransferIn = total?.bdTransferIn ?? 0;
  const stlmOut = total?.stlmOut ?? 0;
  // Both already signed in the source sheet (IN positive, OUT negative), so
  // Adjustment's net effect on Ending Balance is a straight sum, not a
  // subtraction — verified against the sheet's own Running Bal. column.
  const ending = opening + deposit - withdrawal + bdTransferIn + stlmOut;

  const wallets: CardWallet[] = WALLET_ORDER.map((key) => {
    const row = rows.find((r) => r.wallet.toUpperCase() === key);
    return {
      wallet: key,
      runningBal: row?.runningBal ?? 0,
      actualBal: row?.actualBal ?? 0,
      delta: row ? row.runningBal - row.opening : 0,
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
        {up ? '▴' : '▾'} {fmtAbbrev(wallet.delta)} today
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
        <div className="mb-3 mt-5 h-[18px] w-full animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
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

function CihCell({ value, bold }: { value: number; bold?: boolean }) {
  const zero = Math.abs(value) < 0.005;
  const negative = value < 0;
  return (
    <td
      className={`whitespace-nowrap px-4 py-3 text-center text-[13px] tabular-nums ${bold ? 'font-bold' : 'font-medium'} ${
        zero ? 'text-muted-foreground' : negative ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'
      }`}
    >
      {zero ? '−' : `${negative ? '−' : ''}${fmt(value)}`}
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

function BrandCashInhandSection({ rows, total }: { rows: BrandCashRow[]; total: BrandCashRow | null }) {
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
    XLSX.writeFile(workbook, 'brand-balance.xlsx');
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              <th className="whitespace-nowrap px-4 py-3 text-left text-[12px] font-semibold text-muted-foreground">Brand</th>
              {BRAND_CASH_COLUMNS.map((col) => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-center text-[12px] font-semibold text-muted-foreground">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
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
    </section>
  );
}

function BrandCashInhandSkeleton() {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-white dark:bg-[#2a2a2d]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
          <div>
            <div className="h-4 w-40 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            <div className="mt-1.5 h-3 w-56 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
          </div>
        </div>
        <div className="h-8 w-24 shrink-0 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
      </div>
      <div className="p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-2.5">
            <div className="h-3 w-14 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
            <div className="h-3 w-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function BalanceOverviewPage() {
  const [cashoutCard, setCashoutCard] = useState<CardData | null>(null);
  const [sendMoneyCard, setSendMoneyCard] = useState<CardData | null>(null);
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

      const [cashoutRes, sendMoneyRes, cashGoRes, bundleRes, brandCashRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/sendmoney/sheet?t=${Date.now()}`),
        fetch(`/api/cashgo?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
        fetch(`/api/brand-cash-inhand?t=${Date.now()}`),
      ]);
      await assertAllOk([cashoutRes, sendMoneyRes, cashGoRes, bundleRes, brandCashRes]);
      const cashoutText = await cashoutRes.text();
      const sendMoneyText = await sendMoneyRes.text();
      const cashGoText = await cashGoRes.text();
      const bundleText = await bundleRes.text();
      const brandCashText = await brandCashRes.text();

      const todayCashGo = parseTodayCashGo(cashGoText);
      const todayBundle = parseTodayBundle(bundleText);

      // Overall (not per-wallet) today's combined quota vs. processed —
      // Bundle Transfer has no quota concept, so it's null there.
      const cashGoQuotaTotal = todayCashGo.quotaBk + todayCashGo.quotaNg;
      const cashGoQuota = cashGoQuotaTotal > 0 ? { processed: todayCashGo.bk + todayCashGo.ng, total: cashGoQuotaTotal } : null;

      setCashoutCard(buildCardData(parseSheetBlock(cashoutText), 'cashout', 'Cashout', 'CashGo', [
        { key: 'bk', label: 'Bkash', value: todayCashGo.bk, quota: todayCashGo.quotaBk },
        { key: 'ng', label: 'Nagad', value: todayCashGo.ng, quota: todayCashGo.quotaNg },
      ], cashGoQuota));
      setSendMoneyCard(buildCardData(parseSheetBlock(sendMoneyText), 'sendmoney', 'Send Money', 'Bundle Transfer', [
        { key: 'nagad', label: 'Nagad', value: todayBundle.nagad },
        { key: 'rocket', label: 'Rocket', value: todayBundle.rocket },
        { key: 'upay', label: 'UPay', value: todayBundle.upay },
      ], null));

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
          <BrandCashInhandSection rows={brandCashRows} total={brandCashTotal} />
        )}

        {/* Future Balance Overview sections append below this line */}
      </main>
    </div>
  );
}
