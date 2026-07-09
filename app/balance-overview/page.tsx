'use client';

import { useEffect, useState, useCallback } from 'react';
import Image from 'next/image';
import { RefreshCw } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import ConnectionErrorState from '../components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';

function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
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
        runningBal: clean(cols[6]),
        opening: clean(cols[7]),
      };
    });
}

type CardWallet = {
  wallet: string;
  runningBal: number;
  delta: number;
  comingSoon?: boolean;
};

type CardData = {
  productLabel: string;
  product: 'cashout' | 'sendmoney';
  opening: number;
  deposit: number;
  withdrawal: number;
  adjustment: number;
  ending: number;
  wallets: CardWallet[];
};

function buildCardData(rows: WalletFlow[], product: 'cashout' | 'sendmoney', productLabel: string): CardData {
  const total = rows.find((r) => r.wallet.toUpperCase() === 'TOTAL');
  const opening = total?.opening ?? 0;
  const deposit = total?.totalDP ?? 0;
  const withdrawal = total?.totalWD ?? 0;
  // Net of BD-Transfer IN and STLM & BD Transfer Out — both already signed in
  // the source sheet, so this is a straight sum, not a subtraction.
  const adjustment = (total?.bdTransferIn ?? 0) + (total?.stlmOut ?? 0);
  const ending = opening + deposit - withdrawal + adjustment;

  const wallets: CardWallet[] = WALLET_ORDER.map((key) => {
    const row = rows.find((r) => r.wallet.toUpperCase() === key);
    return {
      wallet: key,
      runningBal: row?.runningBal ?? 0,
      delta: row ? row.runningBal - row.opening : 0,
      comingSoon: product === 'sendmoney' && key === 'BKASH',
    };
  });

  return { productLabel, product, opening, deposit, withdrawal, adjustment, ending, wallets };
}

function FlowRow({ label, value, valueClass, last }: { label: string; value: string; valueClass?: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2.5 ${last ? '' : 'border-b border-border'}`}>
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className={`text-[12.5px] font-medium tabular-nums ${valueClass ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function WalletTile({ wallet }: { wallet: CardWallet }) {
  const name = WALLET_DISPLAY_NAMES[wallet.wallet] ?? wallet.wallet;

  if (wallet.comingSoon) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <WalletLogo wallet={wallet.wallet} muted />
          <span className="text-[11px] text-muted-foreground">{name}</span>
        </div>
        <p className="mt-2 text-[12px] font-medium text-muted-foreground">Coming soon</p>
      </div>
    );
  }

  const up = wallet.delta >= 0;
  return (
    <div className="rounded-xl border border-border bg-white px-3 py-2.5 dark:bg-[#2a2a2d]">
      <div className="flex items-center gap-1.5">
        <WalletLogo wallet={wallet.wallet} />
        <span className="text-[11px] text-muted-foreground">{name}</span>
      </div>
      <p className="mt-1.5 text-[15px] font-medium tabular-nums text-foreground">{fmt(wallet.runningBal)}</p>
      <p className={`mt-0.5 text-[10px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
        {up ? '▴' : '▾'} {fmtAbbrev(wallet.delta)} today
      </p>
    </div>
  );
}

function BalanceCard({ data }: { data: CardData }) {
  return (
    <div data-product={data.product} className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="h-[3px] w-full" style={{ background: 'var(--product-accent)' }} />
      <div className="p-5">
        <h3 className="mb-4 text-[13px] font-semibold text-foreground">{data.productLabel}</h3>

        <div>
          <FlowRow label="Opening Balance" value={fmt(data.opening)} />
          <FlowRow label="Deposit" value={`+${fmt(data.deposit)}`} valueClass="text-emerald-600 dark:text-emerald-400" />
          <FlowRow label="Withdrawal" value={`−${fmt(data.withdrawal)}`} valueClass="text-rose-600 dark:text-rose-400" />
          <FlowRow
            label="Adjustment"
            value={`${data.adjustment >= 0 ? '+' : '−'}${fmt(data.adjustment)}`}
            valueClass={data.adjustment >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
            last
          />
        </div>

        <div className="mt-3 flex items-center justify-between rounded-[10px] bg-muted/40 px-3.5 py-3">
          <span className="text-[13px] font-medium text-foreground">Ending Balance</span>
          <span className={`text-[17px] font-medium tabular-nums ${data.ending < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
            {data.ending < 0 ? '−' : ''}{fmt(data.ending)}
          </span>
        </div>

        <div className="mb-3 mt-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Wallet Breakdown</span>
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

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-[#2a2a2d]">
      <div className="h-[3px] w-full bg-slate-200 dark:bg-slate-700" />
      <div className="p-5">
        <div className="h-4 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
        <div className="mt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`flex items-center justify-between py-2.5 ${i < 3 ? 'border-b border-border' : ''}`}>
              <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
              <div className="h-3 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            </div>
          ))}
        </div>
        <div className="mt-3 h-[52px] animate-pulse rounded-[10px] bg-slate-100 dark:bg-slate-800" />
        <div className="mb-3 mt-5 h-3 w-full animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[74px] animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BalanceOverviewPage() {
  const [cashoutCard, setCashoutCard] = useState<CardData | null>(null);
  const [sendMoneyCard, setSendMoneyCard] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [cashoutRes, sendMoneyRes] = await Promise.all([
        fetch(`/api/sheet?t=${Date.now()}`),
        fetch(`/api/sendmoney/sheet?t=${Date.now()}`),
      ]);
      await assertAllOk([cashoutRes, sendMoneyRes]);
      const cashoutText = await cashoutRes.text();
      const sendMoneyText = await sendMoneyRes.text();

      setCashoutCard(buildCardData(parseSheetBlock(cashoutText), 'cashout', 'Agent CashOut'));
      setSendMoneyCard(buildCardData(parseSheetBlock(sendMoneyText), 'sendmoney', 'Personal SendMoney'));
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

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="sticky top-0 z-30 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-4 w-[3px] shrink-0 rounded-full bg-indigo-500" />
            <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">Balance Overview</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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

      <main className="space-y-6 px-4 py-6 md:px-8 md:py-8">
        {loading && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CardSkeleton />
            <CardSkeleton />
          </section>
        )}

        {!loading && error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!loading && !error && cashoutCard && sendMoneyCard && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BalanceCard data={cashoutCard} />
            <BalanceCard data={sendMoneyCard} />
          </section>
        )}

        {/* Future Balance Overview sections append below this line */}
      </main>
    </div>
  );
}
