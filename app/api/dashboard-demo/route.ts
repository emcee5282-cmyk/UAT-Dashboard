import { NextResponse } from 'next/server';
import { fetchRange } from '@/app/lib/googleSheets';
import { clean, rawVal } from '@/app/lib/format';
import { getBusinessToday, manilaMidnight, manilaFields } from '@/app/lib/businessDate';

// Feeds ONLY the Dashboard Demo mockup (public/dashboard-demo.html) — real
// numbers for the sections that have a real source (Balance Overview cards,
// Net Position/Total Deposit/Total Withdrawal, Wallet Summary ledger, trend
// chart), for both Cashout and Send Money. Top Performer Wallet, High
// Volume Agents, Running Balance by Brand, and Cash In Hand stay as the
// demo's own hardcoded mock data — left untouched per explicit instruction,
// even though real sources for those exist too (walletGainRanking/
// top50Agents in app/balance-overview/page.tsx + app/sendmoney/page.tsx,
// /api/brand-ssp-line1(-sendmoney), /api/brand-cash-inhand).
//
// This intentionally does NOT reproduce two pieces of real-page complexity:
// 1. The Postgres-backed "Estimated Opening" override (app/page.tsx,
//    app/lib/estimatedOpening.ts) — Opening Balance here is always the
//    plain sheet-seeded value, same as app/balance-overview/page.tsx and
//    app/sendmoney/page.tsx already do (neither of those two pages uses the
//    override either, only the root app/page.tsx does).
// 2. Send Money's dual-condition cutoff-widening (app/sendmoney/page.tsx's
//    own sendMoneyCutoffDate/estimatedSendMoneyOpeningValid check) — this
//    always uses a flat getBusinessToday() cutoff for both products, same
//    as app/balance-overview/page.tsx's own (simpler) Cashout logic.
//
// Runs server-side (Vercel, effectively UTC), unlike the three real pages
// above which run this same parsing client-side in a browser already set
// to Asia/Manila — so every date this route parses goes through
// manilaMidnight() instead of the real pages' own timezone-unsafe
// `new Date(y, m-1, d)` (see app/lib/businessDate.ts's header comment for
// the exact bug that pattern caused when it ran server-side elsewhere).

export const dynamic = 'force-dynamic';

type WalletRow = {
  wallet: string;
  totalDP: number;
  totalWD: number;
  bdTransferIn: number;
  stlm: number;
  actualBal: number;
  opening: number;
  runningBal: number;
};

function parseWalletSheetRows(rows: string[][]): WalletRow[] {
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => (cell ?? '').trim() !== ''))
    .map((row) => {
      const totalDP = clean(row[1]);
      const totalWD = clean(row[2]);
      const bdTransferIn = clean(row[3]);
      const stlm = clean(row[4]);
      const opening = clean(row[7]);
      return {
        wallet: (row[0] ?? '').replace(/"/g, '').trim(),
        totalDP,
        totalWD,
        bdTransferIn,
        stlm,
        actualBal: clean(row[5]),
        opening,
        runningBal: opening + totalDP + totalWD + bdTransferIn + stlm,
      };
    });
}

// "M/D/YYYY" transaction date (Settlement/Top Up sheets) — Manila-anchored,
// unlike the real pages' own `new Date(y, m-1, d)` (see file header).
function parseTxnDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return manilaMidnight(y, m - 1, d);
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// "CashGo" sheet dates are "June 1" (no year) — inferred from the current
// Manila business year, same convention as businessDate.ts's own
// parseCardCutoffDate.
function parseCashGoDate(raw: string): Date | null {
  const match = (raw ?? '').trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = parseInt(match[2], 10);
  const { year } = manilaFields(new Date());
  return manilaMidnight(year, monthIndex, day);
}

function dateKey(d: Date): string {
  const { year, month, day } = manilaFields(d);
  return `${year}-${month}-${day}`;
}

const WALLET_DISPLAY: Record<string, string> = { BKASH: 'Bkash', NAGAD: 'Nagad', ROCKET: 'Rocket', UPAY: 'UPay' };
const M = 1_000_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Builds an N-day trend series ending the day before `endExclusive`, off a
// date-keyed map already built from the full sheet (no extra fetch needed
// for the 30D view — same rows the 7D series already reads, just a wider
// slice). Powers both the default 7D chart and the 30D toggle in the demo.
function buildDaySeries<T>(
  dataByDate: Map<string, T>,
  emptyEntry: T,
  days: number,
  endExclusive: Date,
  toPoint: (date: string, entry: T) => Record<string, number | string>
): Record<string, number | string>[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(endExclusive.getTime() - (days - 1 - i) * 24 * 60 * 60 * 1000);
    const entry = dataByDate.get(dateKey(d)) ?? emptyEntry;
    const { month, day } = manilaFields(d);
    const dateStr = `${String(month + 1).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
    return toPoint(dateStr, entry);
  });
}

export async function GET() {
  try {
    const [
      cashoutSheetRows, sendMoneySheetRows, openingRows,
      agentBalRows, agstlmtopupRows, cashGoRows,
      sendMoneyBalRows, sendMoneyStlmRows,
    ] = await Promise.all([
      fetchRange('Dashboard Overview!B3:I8'),
      fetchRange('Dashboard Overview!B11:I16'),
      fetchRange('Opening AG'),
      fetchRange('SSP AG BalanceLimit'),
      fetchRange('AG BD STLM + TOPUP'),
      fetchRange('CashGo'),
      fetchRange('SSP PS BalanceLimit'),
      fetchRange('PS BD STLM + TOPUP'),
    ]);

    const cutoff = getBusinessToday();

    // ---------- Cashout ----------
    const cashoutWallets = parseWalletSheetRows(cashoutSheetRows);

    const cashoutOpeningSum = openingRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .reduce((sum, row) => {
        const raw = (row[1] ?? '').replace(/"/g, '').trim();
        if (!raw || raw === '-') return sum;
        const value = parseFloat(raw.replace(/,/g, ''));
        return isNaN(value) ? sum : sum + value;
      }, 0);

    const cashoutWalletDP = new Map<string, number>();
    const cashoutWalletWD = new Map<string, number>();
    agentBalRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .forEach((row) => {
        const wType = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
        if (!wType || wType === '-') return;
        cashoutWalletDP.set(wType, (cashoutWalletDP.get(wType) ?? 0) + clean(row[11]));
        cashoutWalletWD.set(wType, (cashoutWalletWD.get(wType) ?? 0) + clean(row[13]));
      });

    const cashoutWalletTopUp = new Map<string, number>();
    const cashoutWalletStlm = new Map<string, number>();
    agstlmtopupRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .forEach((row) => {
        const topUpAmount = clean((row[2] ?? '').replace(/"/g, '').trim());
        const topUpDate = parseTxnDate((row[3] ?? '').replace(/"/g, '').trim());
        const topUpWallet = (row[4] ?? '').replace(/"/g, '').trim().toLowerCase();
        if (topUpWallet && topUpWallet !== '-' && topUpAmount && topUpDate && topUpDate >= cutoff) {
          cashoutWalletTopUp.set(topUpWallet, (cashoutWalletTopUp.get(topUpWallet) ?? 0) + topUpAmount);
        }
        const stlmAmount = Math.abs(clean((row[8] ?? '').replace(/"/g, '').trim()));
        const stlmDate = parseTxnDate((row[9] ?? '').replace(/"/g, '').trim());
        const stlmWallet = (row[10] ?? '').replace(/"/g, '').trim().toLowerCase();
        if (stlmWallet && stlmWallet !== '-' && stlmAmount && stlmDate && stlmDate >= cutoff) {
          cashoutWalletStlm.set(stlmWallet, (cashoutWalletStlm.get(stlmWallet) ?? 0) + stlmAmount);
        }
      });

    cashoutWallets.forEach((row) => {
      const key = row.wallet.toLowerCase();
      const dp = cashoutWalletDP.get(key) ?? 0;
      const wd = cashoutWalletWD.get(key) ?? 0;
      const topUp = cashoutWalletTopUp.get(key) ?? 0;
      const stlm = cashoutWalletStlm.get(key) ?? 0;
      if (dp) row.totalDP = dp;
      if (wd) row.totalWD = -wd;
      if (topUp) row.bdTransferIn = topUp;
      if (stlm) row.stlm = -stlm;
      row.runningBal = row.opening + row.totalDP + row.totalWD + row.bdTransferIn + row.stlm;
    });

    // CashGo Trend — 7 days ending yesterday (today excluded, in progress),
    // plus today's own figure separately for the progress bar.
    const cashGoByDate = new Map<string, { bk: number; ng: number; bkQuota: number; ngQuota: number }>();
    cashGoRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .forEach((row) => {
        const d = parseCashGoDate((row[1] ?? '').replace(/"/g, '').trim());
        if (!d) return;
        cashGoByDate.set(dateKey(d), {
          bkQuota: clean(row[2]), ngQuota: clean(row[3]),
          bk: clean(row[4]), ng: clean(row[5]),
        });
      });

    const yesterday = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
    const emptyCashGo = { bk: 0, ng: 0, bkQuota: 0, ngQuota: 0 };
    const cashGoPoint = (date: string, t: typeof emptyCashGo) => ({ date, bkash: round2(t.bk / M), nagad: round2(t.ng / M) });
    const cashoutChart = buildDaySeries(cashGoByDate, emptyCashGo, 7, yesterday, cashGoPoint);
    const cashoutChart30 = buildDaySeries(cashGoByDate, emptyCashGo, 30, yesterday, cashGoPoint);
    const cashoutToday = cashGoByDate.get(dateKey(cutoff)) ?? { bk: 0, ng: 0, bkQuota: 0, ngQuota: 0 };

    const cashoutDataRows = cashoutWallets.filter((r) => r.wallet.toLowerCase() !== 'total');
    const cashoutTotalDP = cashoutDataRows.reduce((s, r) => s + r.totalDP, 0);
    const cashoutTotalWD = cashoutDataRows.reduce((s, r) => s + Math.abs(r.totalWD), 0);
    const cashoutTotalWDSigned = cashoutDataRows.reduce((s, r) => s + r.totalWD, 0);
    const cashoutTotalTopUp = cashoutDataRows.reduce((s, r) => s + r.bdTransferIn, 0);
    const cashoutTotalStlm = cashoutDataRows.reduce((s, r) => s + r.stlm, 0);
    const cashoutActualTotal = cashoutDataRows.reduce((s, r) => s + r.actualBal, 0);
    const cashoutRunningTotal = cashoutDataRows.reduce((s, r) => s + r.runningBal, 0);
    const cashoutVsOpening = cashoutRunningTotal - cashoutOpeningSum;

    // ---------- Send Money ----------
    const sendMoneyWallets = parseWalletSheetRows(sendMoneySheetRows);

    const sendMoneyOpeningSum = openingRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .reduce((sum, row) => {
        const raw = rawVal(row[12]);
        if (!raw || raw === '-') return sum;
        const value = parseFloat(raw.replace(/,/g, ''));
        return isNaN(value) ? sum : sum + value;
      }, 0);

    const WALLET_TYPE_LABELS: Record<string, string> = { NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY', BK: 'BKASH' };
    function walletTypeLabelFromName(name: string): string | null {
      const segments = name.trim().toUpperCase().split('-');
      return WALLET_TYPE_LABELS[segments[segments.length - 1]] ?? null;
    }

    const sendMoneyWalletDP = new Map<string, number>();
    const sendMoneyWalletWD = new Map<string, number>();
    sendMoneyBalRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .forEach((row) => {
        const name = rawVal(row[0]);
        if (!name || name === '-') return;
        const label = walletTypeLabelFromName(name);
        if (!label) return;
        sendMoneyWalletDP.set(label, (sendMoneyWalletDP.get(label) ?? 0) + clean(row[11]));
        sendMoneyWalletWD.set(label, (sendMoneyWalletWD.get(label) ?? 0) + clean(row[13]));
      });

    const sendMoneyWalletTopUp = new Map<string, number>();
    const sendMoneyWalletStlm = new Map<string, number>();
    const bundleByDate = new Map<string, { NAGAD: number; ROCKET: number; UPAY: number }>();
    const addBundleRow = (nameRaw: string, amountRaw: string, dateRaw: string, walletRaw: string, typeRaw: string) => {
      if (rawVal(typeRaw).trim().toUpperCase() !== 'BUNDLE TRANSFER') return;
      const name = rawVal(nameRaw);
      if (!name || name === '-') return;
      const amount = Math.abs(clean(rawVal(amountRaw)));
      if (!amount) return;
      const date = parseTxnDate(rawVal(dateRaw));
      if (!date) return;
      const wallet = rawVal(walletRaw).trim().toUpperCase();
      if (wallet !== 'NAGAD' && wallet !== 'ROCKET' && wallet !== 'UPAY') return;
      const key = dateKey(date);
      const existing = bundleByDate.get(key) ?? { NAGAD: 0, ROCKET: 0, UPAY: 0 };
      existing[wallet as 'NAGAD' | 'ROCKET' | 'UPAY'] += amount;
      bundleByDate.set(key, existing);
    };

    sendMoneyStlmRows
      .slice(1)
      .filter((row) => row.some((c) => (c ?? '').trim() !== ''))
      .forEach((row) => {
        const topUpName = rawVal(row[1]);
        const topUpAmount = clean(rawVal(row[2]));
        const topUpDate = parseTxnDate(rawVal(row[3]));
        if (topUpName && topUpName !== '-' && topUpAmount && topUpDate && topUpDate >= cutoff) {
          const label = walletTypeLabelFromName(topUpName);
          if (label) sendMoneyWalletTopUp.set(label, (sendMoneyWalletTopUp.get(label) ?? 0) + topUpAmount);
        }
        const stlmName = rawVal(row[7]);
        const stlmAmount = Math.abs(clean(rawVal(row[8])));
        const stlmDate = parseTxnDate(rawVal(row[9]));
        if (stlmName && stlmName !== '-' && stlmAmount && stlmDate && stlmDate >= cutoff) {
          const label = walletTypeLabelFromName(stlmName);
          if (label) sendMoneyWalletStlm.set(label, (sendMoneyWalletStlm.get(label) ?? 0) + stlmAmount);
        }
        // Bundle Transfer Trend — separate grouping (explicit wallet col +
        // Type filter), this month + prior-month archive (cols shifted +15).
        addBundleRow(row[7], row[8], row[9], row[10], row[11]);
        addBundleRow(row[22], row[23], row[24], row[25], row[26]);
      });

    sendMoneyWallets.forEach((row) => {
      const key = row.wallet.toUpperCase();
      const dp = sendMoneyWalletDP.get(key) ?? 0;
      const wd = sendMoneyWalletWD.get(key) ?? 0;
      const topUp = sendMoneyWalletTopUp.get(key) ?? 0;
      const stlm = sendMoneyWalletStlm.get(key) ?? 0;
      if (dp) row.totalDP = dp;
      if (wd) row.totalWD = -wd;
      if (topUp) row.bdTransferIn = topUp;
      if (stlm) row.stlm = -stlm;
      row.runningBal = row.opening + row.totalDP + row.totalWD + row.bdTransferIn + row.stlm;
    });

    const emptyBundle = { NAGAD: 0, ROCKET: 0, UPAY: 0 };
    const bundlePoint = (date: string, t: typeof emptyBundle) => ({ date, nagad: round2(t.NAGAD / M), rocket: round2(t.ROCKET / M), upay: round2(t.UPAY / M) });
    const sendMoneyChart = buildDaySeries(bundleByDate, emptyBundle, 7, yesterday, bundlePoint);
    const sendMoneyChart30 = buildDaySeries(bundleByDate, emptyBundle, 30, yesterday, bundlePoint);
    const sendMoneyTodayBundle = bundleByDate.get(dateKey(cutoff)) ?? { NAGAD: 0, ROCKET: 0, UPAY: 0 };
    const sendMoneyTodayTotal = sendMoneyTodayBundle.NAGAD + sendMoneyTodayBundle.ROCKET + sendMoneyTodayBundle.UPAY;

    const sendMoneyDataRows = sendMoneyWallets.filter((r) => r.wallet.toUpperCase() !== 'TOTAL');
    const sendMoneyTotalDP = sendMoneyDataRows.reduce((s, r) => s + r.totalDP, 0);
    const sendMoneyTotalWD = sendMoneyDataRows.reduce((s, r) => s + Math.abs(r.totalWD), 0);
    const sendMoneyTotalWDSigned = sendMoneyDataRows.reduce((s, r) => s + r.totalWD, 0);
    const sendMoneyTotalTopUp = sendMoneyDataRows.reduce((s, r) => s + r.bdTransferIn, 0);
    const sendMoneyTotalStlm = sendMoneyDataRows.reduce((s, r) => s + r.stlm, 0);
    const sendMoneyActualTotal = sendMoneyDataRows.reduce((s, r) => s + r.actualBal, 0);
    const sendMoneyRunningTotal = sendMoneyDataRows.reduce((s, r) => s + r.runningBal, 0);
    const sendMoneyVsOpening = sendMoneyRunningTotal - sendMoneyOpeningSum;

    // ---------- Shape for the demo's own render functions ----------
    const toLedgerWallets = (walletRows: WalletRow[]) =>
      walletRows
        .filter((r) => !['TOTAL', ''].includes(r.wallet.toUpperCase()))
        .map((r) => ({
          name: r.wallet.toUpperCase(),
          dp: r.totalDP,
          wd: r.totalWD,
          mid: r.bdTransferIn !== 0 ? r.bdTransferIn : null,
          settlement: r.stlm !== 0 ? r.stlm : null,
          actual: r.actualBal,
          running: r.runningBal,
          change: r.runningBal - r.opening,
        }));

    const toOverviewWallets = (walletRows: WalletRow[], maxTotal: number) =>
      walletRows
        .filter((r) => !['TOTAL', ''].includes(r.wallet.toUpperCase()))
        .map((r) => ({
          name: WALLET_DISPLAY[r.wallet.toUpperCase()] ?? r.wallet,
          total: round2(r.runningBal / M),
          change: round2((r.runningBal - r.opening) / M),
          actual: round2(r.actualBal / M),
        }));

    return NextResponse.json({
      cashout: {
        dep: cashoutTotalDP,
        wd: cashoutTotalWD,
        actual: cashoutActualTotal,
        running: cashoutRunningTotal,
        changeVsOpening: cashoutVsOpening,
        chart: cashoutChart,
        chart30: cashoutChart30,
        wallets: toLedgerWallets(cashoutWallets),
        overview: {
          opening: cashoutOpeningSum,
          deposit: cashoutTotalDP,
          withdrawal: cashoutTotalWDSigned,
          topup: cashoutTotalTopUp,
          settlement: cashoutTotalStlm,
          ending: cashoutRunningTotal,
          endingChange: cashoutVsOpening,
          progressValue: round2((cashoutToday.bk + cashoutToday.ng) / M),
          progressQuota: round2((cashoutToday.bkQuota + cashoutToday.ngQuota) / M) || undefined,
          // CashGo genuinely has 2 wallets, each with its own quota (same
          // source app/page.tsx's TodayStrip reads: 'CashGo' sheet cols
          // [2]/[3]=Bkash/Nagad quota, [4]/[5]=processed) — always both,
          // even a wallet with quota=0 (e.g. Bkash some days) still has
          // real processed volume worth showing, per explicit instruction
          // not to hide it.
          todayWallets: [
            { name: 'Bkash', value: round2(cashoutToday.bk / M), quota: round2(cashoutToday.bkQuota / M) || undefined },
            { name: 'Nagad', value: round2(cashoutToday.ng / M), quota: round2(cashoutToday.ngQuota / M) || undefined },
          ],
          wallets: toOverviewWallets(cashoutWallets, cashoutRunningTotal),
        },
      },
      sendmoney: {
        dep: sendMoneyTotalDP,
        wd: sendMoneyTotalWD,
        actual: sendMoneyActualTotal,
        running: sendMoneyRunningTotal,
        changeVsOpening: sendMoneyVsOpening,
        chart: sendMoneyChart,
        chart30: sendMoneyChart30,
        wallets: toLedgerWallets(sendMoneyWallets),
        overview: {
          opening: sendMoneyOpeningSum,
          deposit: sendMoneyTotalDP,
          withdrawal: sendMoneyTotalWDSigned,
          topup: sendMoneyTotalTopUp,
          settlement: sendMoneyTotalStlm,
          ending: sendMoneyRunningTotal,
          endingChange: sendMoneyVsOpening,
          // Bundle Transfer has no quota concept (same as the real page) —
          // quota mirrors value so the progress bar reads "100% used" once
          // there's any activity, "No activity yet" otherwise.
          progressValue: round2(sendMoneyTodayTotal / M),
          progressQuota: round2(sendMoneyTodayTotal / M) || undefined,
          // No quota field at all (unlike CashGo) — the demo renders this
          // as a plain chip list instead of quota-progress rows, one chip
          // per wallet that actually moved bundle-transfer volume today
          // (sendMoneyTodayBundle, the same per-wallet split the Bundle
          // Transfer Trend chart already sources from). Filtered to >0 so
          // a day with only 1 active wallet shows just that 1 chip, not 3
          // padded with zeros.
          todayWallets: [
            { name: 'Nagad', value: round2(sendMoneyTodayBundle.NAGAD / M) },
            { name: 'Rocket', value: round2(sendMoneyTodayBundle.ROCKET / M) },
            { name: 'Upay', value: round2(sendMoneyTodayBundle.UPAY / M) },
          ].filter((w) => w.value > 0),
          wallets: toOverviewWallets(sendMoneyWallets, sendMoneyRunningTotal),
        },
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build dashboard demo data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
