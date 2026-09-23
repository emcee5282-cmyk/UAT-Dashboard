import { NextResponse } from 'next/server';
import { clean } from '@/app/lib/format';
import { getBusinessToday, manilaMidnight, manilaFields, toBusinessDate } from '@/app/lib/businessDate';
import { readEstimatedOpeningDisplayPg } from '@/app/lib/db/read/estimatedOpening';
import { getSspLine1TopUpSettlement } from '@/app/lib/db/read/sspLine1';
import { getSendMoneyTransactionsSince } from '@/app/lib/db/read/sendMoneyTransactions';
import { getOpeningBalanceTrend } from '@/app/lib/db/read/openingBalanceTrend';
import { getDailyTxnCashgoHistory } from '@/app/lib/db/read/dailyTxnCashgo';
import { readDashboardManualBalancesPg } from '@/app/lib/db/read/dashboardOverview';
import { getDailyTxnLedgerEntriesForDate } from '@/app/lib/db/read/dailyTxnLedger';
import { getLatestPgBalanceSnapshot } from '@/app/lib/db/read/dailyTxnPgBalance';
import { computeClosingTotal, DAILY_TXN_LEDGER_BRANDS } from '@/app/lib/services/dailyTxnRolloverService';
import { getAgentBalances, getLatestOpeningImportCutoff } from '@/app/lib/services/balanceService';
import { getAgentWalletRawRows } from '@/app/lib/db/read/agentWalletRaw';
import { getBalanceLimitLastImport } from '@/app/lib/db/read/balanceLimit';

// Production Dashboard data route — supersedes app/api/dashboard-demo/route.ts
// (left untouched, still feeds public/dashboard-demo.html) for the new "/"
// page. Ports EVERYTHING dashboard-demo's own header comment flagged as
// deliberately skipped there:
//   1. The Postgres-backed "Estimated Opening" override (app/page.tsx,
//      app/lib/estimatedOpening.ts) — Opening Balance below uses the
//      Estimated Opening value once its validity conditions are met.
//   2. Cashout + Send Money's dual-condition cutoff-widening (app/page.tsx's
//      cashoutLiveCutoff/sendMoneyLiveCutoff) — Settlement/Top Up figures
//      (including the CashGo/Bundle Transfer "Today" strip) keep
//      accumulating from a stale day forward instead of resetting to 0.
//   3. Top Performer Wallet + High Volume Agents (new: `topPerformers`,
//      `agents`), ported from app/balance-overview/page.tsx (~907-914) and
//      app/sendmoney/page.tsx (~528-545).
//   4. Running Balance by Brand (new: `brandBalance`), ported from
//      app/page.tsx's SspLine1Section/parseSspLine1 + live Postgres
//      Top Up/Settlement (getSspLine1TopUpSettlement) — NOT
//      app/balance-overview/page.tsx's older agstlmtopup-derived version.
//   5. Cash In Hand (new: `cashInHand`), ported from app/page.tsx's
//      BrandCashInhandSection/parseBrandCashInhand, with sspAg/sspPs
//      reconciled from #4's own live totals (not the sheet's own columns).
//
// `cashout`/`sendmoney`/`chart`/`chart30`/`wallets`/`overview` keep the
// exact same shape dashboard-demo already returns (a strict superset, not a
// breaking change) — only the VALUES some of those fields carry now differ
// when the Estimated Opening override / cutoff-widening are active, exactly
// as intended by #1/#2 above.
//
// Same Manila-timezone-safe patterns as dashboard-demo (manilaMidnight/
// manilaFields/getBusinessToday, own dateKey/parseCashGoDate/parseTxnDate) —
// this runs server-side (Vercel, effectively UTC), so every date parsed here
// goes through those helpers instead of a runtime-local `new Date(y, m, d)`.

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

type AgentRow = {
  agentName: string;
  opening: number;
  runningBalance: number;
  totalDP: number;
  balanceInside: number;
};

type TopPerformerRow = { wallet: string; gain: number; actualBal: number };

// "Brand Balance!B3:G13" (Cashout) / "!B16:G26" (Send Money) — Opening/
// Deposit/Withdrawal/Total are the sheet's own STATIC (non-live, manually
// seeded) columns; per the real UI's "Phase 10" decision these render blank
// there and are NOT to be treated as live figures the way topUp/settlement
// are. Prefixed `static*` here (rather than bare `opening`/`deposit`/etc.)
// so a consumer can't mistake them for live data by field name alone.
type BrandBalanceRow = {
  brand: string;
  topUp: number;
  settlement: number;
  staticOpening: number;
  staticDeposit: number;
  staticWithdrawal: number;
  staticTotal: number;
};

type CashInHandRow = {
  brand: string;
  sspAg: number;
  sspPs: number;
  ess: number;
  autopay: number;
  // False for AUTOPAY_UNSUPPORTED_BRANDS (see below) — UI should render
  // "Not Supported" instead of `autopay` for those rows. `autopay` itself is
  // still passed through as whatever the sheet holds (not zeroed/nulled) so
  // no data is silently discarded.
  autopaySupported: boolean;
  expay: number;
  totalBrandCIH: number;
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

// Postgres's own "YYYY-MM-DD" (wallet_transactions.occurred_on) — Manila-
// anchored, same as parseTxnDate above.
function parseIsoDateManila(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('-');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return null;
  return manilaMidnight(y, m - 1, d);
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
// slice). Powers both the default 7D chart and the 30D toggle.
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

// Running Balance card's trend sparkline — openingBalanceDaily only ever has
// however many days have actually been snapshotted so far (no fixed-length
// zero-padded grid the way the 7D/30D charts get from buildDaySeries), since
// a real 0.00M day would be indistinguishable from "no snapshot yet".
function toOpeningTrendPoints(rows: { trendDate: string; totalAmount: number }[]): { date: string; value: number }[] {
  return rows.map((r) => {
    const [, m, d] = r.trendDate.split('-').map(Number);
    return { date: `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`, value: round2(r.totalAmount / M) };
  });
}

// Phase 10 — "YYYY-MM-DD" for getSspLine1TopUpSettlement's `cutoff` param.
// Ported verbatim from app/page.tsx's formatCutoffDateKey — reads back via
// manilaFields() (not .toISOString(), which round-trips through UTC and can
// shift a Manila-midnight instant back a calendar day).
function formatCutoffDateKey(date: Date): string {
  const { year, month, day } = manilaFields(date);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "CashGo/Bundle Transfer · Today" label — per explicit instruction, once
// the cutoff-widening above kicks in (Opening stale, no valid Estimated
// Balance yet), the strip is showing a PRIOR business day's figure, not an
// empty "today," so the label should say which day that actually is
// instead of claiming "Today" for data that isn't from today.
const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShortDateLabel(date: Date): string {
  const { month, day } = manilaFields(date);
  return `${SHORT_MONTH_NAMES[month]} ${day}`;
}

// CashGo/Bundle Transfer "Today" strip's own real source of truth — per
// explicit instruction: today wins outright whenever it has real activity
// (labeled "Today"), full stop. Otherwise this walks backward day-by-day
// through the same history window already loaded for the trend charts
// (bounded by `maxDaysBack`, matching `bundleHistorySince`) for the most
// recent day that DOES have activity, and reports that day's own figure +
// date instead of collapsing to an empty "No Activity" state the moment
// today itself is quiet. `hasActivity` is caller-supplied (not "any field
// nonzero") specifically so quota fields (CashGo's bkQuota/ngQuota, always
// pre-set regardless of whether anything actually posted) never count as
// activity on their own.
function latestActivityDay<T>(
  byDate: Map<string, T>,
  cutoff: Date,
  empty: T,
  maxDaysBack: number,
  hasActivity: (t: T) => boolean
): { data: T; date: Date } {
  const today = byDate.get(dateKey(cutoff));
  if (today && hasActivity(today)) return { data: today, date: cutoff };
  for (let i = 1; i <= maxDaysBack; i++) {
    const date = new Date(cutoff.getTime() - i * 24 * 60 * 60 * 1000);
    const entry = byDate.get(dateKey(date));
    if (entry && hasActivity(entry)) return { data: entry, date };
  }
  // No activity anywhere in the loaded window — falls back to today's own
  // (empty) bucket, same terminal "No Activity, Today" state as before.
  return { data: empty, date: cutoff };
}

// Bundle Transfer's own variant, per explicit instruction — Send Money has
// no quota concept to misrepresent by combining days (unlike CashGo's
// per-wallet quota bars above, which stay on latestActivityDay's
// single-day pick), so instead of reporting just the most recent active
// day in isolation, this sums EVERY day from that day through today
// inclusive. That means a same-day update (today) still gets folded into
// the total rather than being dropped — "from last update up to today, if
// there's something [today too]," per explicit instruction — while the
// label still reports the day the range actually started from (or "Today"
// when today itself was already the most recent activity, i.e. no gap to
// sum across at all).
function sumActivitySinceLastUpdate<T extends Record<string, number>>(
  byDate: Map<string, T>,
  cutoff: Date,
  empty: T,
  maxDaysBack: number,
  hasActivity: (t: T) => boolean
): { data: T; date: Date } {
  const todayEntry = byDate.get(dateKey(cutoff));
  let startDate = cutoff;
  if (!todayEntry || !hasActivity(todayEntry)) {
    let found = false;
    for (let i = 1; i <= maxDaysBack; i++) {
      const date = new Date(cutoff.getTime() - i * 24 * 60 * 60 * 1000);
      const entry = byDate.get(dateKey(date));
      if (entry && hasActivity(entry)) {
        startDate = date;
        found = true;
        break;
      }
    }
    if (!found) return { data: empty, date: cutoff };
  }

  const merged = { ...empty };
  const dayCount = Math.round((cutoff.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  for (let i = 0; i <= dayCount; i++) {
    const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    const entry = byDate.get(dateKey(date));
    if (!entry) continue;
    (Object.keys(empty) as (keyof T)[]).forEach((key) => {
      merged[key] = ((merged[key] ?? 0) + (entry[key] ?? 0)) as T[keyof T];
    });
  }
  return { data: merged, date: startDate };
}

type RawBrandBalanceRow = { brand: string; opening: number; deposit: number; withdrawal: number; total: number };

// Per-brand rollup of one Daily Transaction Entry ledger card (Operations
// tab) for a single business date, using the exact same Opening/Deposit-
// Withdrawal/Adjustment (or the 'ess' split) Total formula that page itself
// displays — per explicit instruction, SSP Line 1 & 2's Opening/Deposit/
// Withdrawal/Total (below) and Brand Cash In Hand's Ess/Autopay/Expay
// columns (further down) both read from here now, not the old "Brand
// Balance" sheet/table. Settlement stays untouched — it already reads
// wallet_transactions (getSspLine1TopUpSettlement below), the same live
// source the Settlement page itself uses, not Daily Txn Entry at all.
// Same ledgerId -> pgKey mapping as /api/daily-txn-entry/ledger/route.ts
// (the two tabs use different strings for the same gateway: 'ess'/'essPg',
// 'atp'/'autopay' — everything else matches).
const LEDGER_TO_PG_KEY: Record<string, string> = {
  ssp1: 'ssp1', ssp2: 'ssp2', ess: 'essPg', atp: 'autopay', expay: 'expay', hkpay: 'hkpay',
};

async function getDailyTxnLedgerBrandTotals(ledgerId: string, businessDate: string): Promise<RawBrandBalanceRow[]> {
  const rows = await getDailyTxnLedgerEntriesForDate(ledgerId, businessDate);
  const byBrand = new Map<string, { rowKey: string; amount: number }[]>();
  for (const r of rows) {
    const arr = byBrand.get(r.brand) ?? [];
    arr.push({ rowKey: r.rowKey, amount: r.amount });
    byBrand.set(r.brand, arr);
  }

  // Report tab's PG Closing Balances is the PRIMARY source for "Opening
  // Balance" (per explicit instruction, same as the Operations tab's own
  // ledger card) — dailyTxnLedgerEntry's own 'opening' row is only a
  // backup/recording copy. Without this overlay, a day with only Opening
  // recorded (no Deposit/Withdrawal/Adjustment entered yet) reads as all
  // zeros here even though the real page shows a real Total — this was the
  // exact bug reported live (Brand Cash In Hand showing "-" everywhere
  // while Daily Txn Entry's own cards showed real Opening Balance figures).
  const pgKey = LEDGER_TO_PG_KEY[ledgerId];
  const pgSnapshot = pgKey ? await getLatestPgBalanceSnapshot(pgKey, businessDate) : null;

  const kind = ledgerId === 'ess' ? 'ess' : 'standard';
  return DAILY_TXN_LEDGER_BRANDS.map((brand) => {
    const entries = byBrand.get(brand) ?? [];
    const get = (key: string) => entries.find((e) => e.rowKey === key)?.amount ?? 0;
    const overlayOpening = pgSnapshot?.values[brand];
    const entriesForTotal = overlayOpening === undefined
      ? entries
      : [...entries.filter((e) => e.rowKey !== 'opening'), { rowKey: 'opening', amount: overlayOpening }];
    return {
      brand,
      opening: overlayOpening ?? get('opening'),
      deposit: kind === 'ess' ? get('dpBkash') + get('dpNagad') : get('deposit'),
      withdrawal: kind === 'ess' ? get('wdBkash') + get('wdNagad') : get('withdrawal'),
      total: computeClosingTotal(entriesForTotal, kind),
    };
  });
}

// Brands with no Autopay integration at all — ported verbatim from
// app/page.tsx's own AUTOPAY_UNSUPPORTED_BRANDS.
const AUTOPAY_UNSUPPORTED_BRANDS = ['B3', 'B4', 'B5', 'J1', 'T1'];

export async function GET() {
  try {
    // 32 days back covers the 30D trend chart's full window (ending
    // yesterday) with a couple days' margin — Send Money's Top Up/
    // Settlement now reads live wallet_transactions instead of the
    // "PS BD STLM + TOPUP" sheet, whose sync pipeline is disabled and no
    // longer carries transactions entered after the Postgres migration.
    const bundleHistorySince = formatCutoffDateKey(new Date(getBusinessToday().getTime() - 32 * 24 * 60 * 60 * 1000));
    const todayKey = formatCutoffDateKey(getBusinessToday());
    const [
      cashoutSheetRows, sendMoneySheetRows,
      cashoutAgentWalletRaw, cashoutTransactions, cashGoHistoryRows,
      sendMoneyAgentWalletRaw, sendMoneyTransactions,
      ssp1LedgerRows, ssp2LedgerRows, essLedgerRows, atpLedgerRows, expayLedgerRows,
      estimatedOpening, estimatedSendMoneyOpening,
      openingTrendCashout, openingTrendSendMoney,
      cashoutAgentBalances, sendMoneyAgentBalances,
      cashoutOpeningImportCutoff, sendMoneyOpeningImportCutoff,
    ] = await Promise.all([
      // Wallet Summary — PostgreSQL (dashboard_manual_balances), not the
      // "Dashboard Overview" sheet. readDashboardManualBalancesPg() already
      // returns the exact same header+row shape fetchRange() used to
      // (confirmed against parseWalletSheetRows' own column indices), so
      // nothing downstream needed to change.
      readDashboardManualBalancesPg('cashout'),
      readDashboardManualBalancesPg('sendmoney'),
      // Wallet-type-level DP/WD (Wallet Summary's live override) — Postgres
      // (agent_wallets), not "SSP AG BalanceLimit"/"SSP PS BalanceLimit".
      // Raw per-agent-wallet rows, not pre-aggregated, so Send Money's own
      // BD-keyword segregation (below) still works off the agent's own code,
      // same as it always did.
      getAgentWalletRawRows('cashout'),
      // Wallet-type-level Top Up/Settlement — Postgres (wallet_transactions),
      // not "AG BD STLM + TOPUP". Same wide 32-day window as Send Money's
      // own equivalent below (bundleHistorySince), filtered down to
      // cashoutLiveCutoff inline further down — mirrors Send Money's
      // existing pattern exactly, now shared by both products.
      getSendMoneyTransactionsSince('cashout', bundleHistorySince),
      // CashGo Trend — PostgreSQL (Daily Transaction Entry's own CashGo tab,
      // daily_txn_cashgo_entry), not the old "CashGo" sheet. Confirmed with
      // the user directly: that sheet is not the real source; the Daily Txn
      // Entry table is, since its "process" value already IS that day's
      // final saved figure the moment the business day rolls over (the
      // nightly rollover never touches a past day's row, only creates
      // today's blank one — so no separate "capture the last input" step is
      // needed here, the stored row already IS the last input).
      getDailyTxnCashgoHistory(bundleHistorySince),
      getAgentWalletRawRows('sendmoney'),
      getSendMoneyTransactionsSince('sendmoney', bundleHistorySince),
      // SSP Line 1 & 2 (Opening/Deposit/Withdrawal/Total) and Brand Cash In
      // Hand's Ess/Autopay/Expay columns — PostgreSQL, read straight from
      // Daily Transaction Entry's own ledger cards (daily_txn_ledger_entry),
      // not the old "Brand Balance" sheet/table. Confirmed with the user
      // directly: those cards' own Totals ARE the real source for these,
      // today's business date only (this section has always been a live
      // "as of today" snapshot, same as Wallet Summary above).
      getDailyTxnLedgerBrandTotals('ssp1', todayKey),
      getDailyTxnLedgerBrandTotals('ssp2', todayKey),
      getDailyTxnLedgerBrandTotals('ess', todayKey),
      getDailyTxnLedgerBrandTotals('atp', todayKey),
      getDailyTxnLedgerBrandTotals('expay', todayKey),
      // Estimated Opening override — PostgreSQL (readEstimatedOpeningDisplayPg,
      // the exact same reader the Balance pages' own /api/opening/estimated-balance
      // and /api/sendmoney/opening/estimated-balance GET routes already use),
      // not app/lib/estimatedOpening.ts's readCashoutEstimatedOpening/
      // readSendMoneyEstimatedOpening — those two silently hit Google Sheets
      // internally (fetchRange against an "Import Log" sheet tab) and
      // swallow the failure into an empty-defaults return, which is exactly
      // why this went unnoticed: it never surfaced as a visible error.
      readEstimatedOpeningDisplayPg('cashout'),
      readEstimatedOpeningDisplayPg('sendmoney'),
      getOpeningBalanceTrend('cashout', bundleHistorySince),
      getOpeningBalanceTrend('sendmoney', bundleHistorySince),
      // High Volume Agents — Postgres (balanceService.ts's getAgentBalances,
      // the exact same per-agent figures the Balance page shows), not the
      // "Opening AG" roster merged with the sheets above. Opening/Total DP/
      // Balance Inside for the top-50 ranking all come straight from here
      // now.
      getAgentBalances('cashout'),
      getAgentBalances('sendmoney'),
      // "When was Opening last refreshed" — Postgres (import_batches' own
      // completedAt for the latest completed Opening import), not "Opening
      // AG"'s own "REPORT LAST UPDATE"/"UPDATED TIME" sheet card. This was
      // the very last Google Sheets read anywhere in this route.
      getLatestOpeningImportCutoff('cashout'),
      getLatestOpeningImportCutoff('sendmoney'),
    ]);

    const cutoff = getBusinessToday();

    // ---------- Estimated Opening override + cutoff-widening ----------
    // Dual-condition validity rule ported verbatim from app/page.tsx (both
    // Cashout's and Send Money's own copies are — per explicit instruction
    // there — intentionally symmetric): the override only activates once
    // BOTH (1) Opening's own last-import timestamp (getLatestOpeningImportCutoff,
    // Postgres — was "Opening AG"'s own "Updated Time" sheet card) is still
    // showing the PREVIOUS business day (today's real reset hasn't happened
    // yet), AND (2) the Estimated Opening upload's own "Last Updated"
    // timestamp is itself from TODAY's business day (a stale, un-refreshed
    // upload must not keep being used just because Opening's own reset is
    // also running late). Once Opening's own import lands for today, the
    // override turns off even if a same-day upload still exists.
    const cashoutCutoffDate = cashoutOpeningImportCutoff;
    const sendMoneyCutoffDate = sendMoneyOpeningImportCutoff;

    const estimatedOpeningValid =
      cashoutCutoffDate !== null &&
      cashoutCutoffDate.getTime() < cutoff.getTime() &&
      estimatedOpening.uploadedAt !== null &&
      toBusinessDate(estimatedOpening.uploadedAt).getTime() === cutoff.getTime();

    const estimatedSendMoneyOpeningValid =
      sendMoneyCutoffDate !== null &&
      sendMoneyCutoffDate.getTime() < cutoff.getTime() &&
      estimatedSendMoneyOpening.uploadedAt !== null &&
      toBusinessDate(estimatedSendMoneyOpening.uploadedAt).getTime() === cutoff.getTime();

    const cashoutOpeningOverride = estimatedOpeningValid
      ? Array.from(estimatedOpening.balancesWithFallback.values()).reduce((s, v) => s + v, 0)
      : undefined;
    const sendMoneyOpeningOverride = estimatedSendMoneyOpeningValid
      ? Array.from(estimatedSendMoneyOpening.balancesWithFallback.values()).reduce((s, v) => s + v, 0)
      : undefined;

    // Top Up/Settlement totals reset at the 2AM business-day rollover,
    // UNLESS Opening is still stale (hasn't refreshed for today) AND no
    // valid Estimated Balance covers the gap yet — then these widen to sum
    // from Opening's own last-refresh day through today, so Settlement/
    // TopUp posted "yesterday" doesn't disappear once the calendar rolls
    // over. Once a valid Estimated Balance exists, it already bakes that
    // stale day in (see app/lib/estimatedOpening.ts), so this goes back to
    // today-only to avoid counting it twice.
    const cashoutLiveCutoff = (cashoutCutoffDate !== null && cashoutCutoffDate.getTime() < cutoff.getTime() && !estimatedOpeningValid)
      ? cashoutCutoffDate
      : cutoff;
    const sendMoneyLiveCutoff = (sendMoneyCutoffDate !== null && sendMoneyCutoffDate.getTime() < cutoff.getTime() && !estimatedSendMoneyOpeningValid)
      ? sendMoneyCutoffDate
      : cutoff;

    // ---------- Cashout ----------
    const cashoutWallets = parseWalletSheetRows(cashoutSheetRows);

    // Postgres (sum of getAgentBalances' own per-agent openingBalance), not
    // "Opening AG" col B summed by hand — same figure, same roster.
    const cashoutOpeningSum = cashoutAgentBalances.reduce((sum, a) => sum + a.openingBalance, 0);
    const cashoutOpeningEffective = cashoutOpeningOverride ?? cashoutOpeningSum;

    // Wallet-type DP/WD — Postgres (agent_wallets via getAgentWalletRawRows),
    // not "SSP AG BalanceLimit". Per-agent DP/WD/Balance Inside for High
    // Volume Agents no longer needs deriving here at all — getAgentBalances
    // (cashoutAgentBalances, fetched above) already computes those same
    // figures per-agent server-side.
    const cashoutWalletDP = new Map<string, number>();
    const cashoutWalletWD = new Map<string, number>();
    cashoutAgentWalletRaw.forEach((row) => {
      if (!row.walletTypeCode) return;
      const wType = row.walletTypeCode.toLowerCase();
      cashoutWalletDP.set(wType, (cashoutWalletDP.get(wType) ?? 0) + row.totalDp);
      cashoutWalletWD.set(wType, (cashoutWalletWD.get(wType) ?? 0) + row.totalWd);
    });

    // Wallet-type Top Up/Settlement — Postgres (wallet_transactions via
    // getSendMoneyTransactionsSince('cashout', ...)), not "AG BD STLM +
    // TOPUP". Mirrors Send Money's own equivalent loop further down exactly
    // (same wallet_transactions shape, same cutoff-filtering rule), keyed
    // lowercase here to match cashoutWallets.forEach's own lookup below.
    const cashoutWalletTopUp = new Map<string, number>();
    const cashoutWalletStlm = new Map<string, number>();
    cashoutTransactions.forEach((txn) => {
      if (!txn.amount) return;
      const wallet = (txn.wallet ?? '').trim().toLowerCase();
      const date = parseIsoDateManila(txn.occurredOn);
      if (!wallet || !date || date < cashoutLiveCutoff) return;
      if (txn.transactionType === 'topup') {
        cashoutWalletTopUp.set(wallet, (cashoutWalletTopUp.get(wallet) ?? 0) + txn.amount);
      } else {
        cashoutWalletStlm.set(wallet, (cashoutWalletStlm.get(wallet) ?? 0) + txn.amount);
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

    // High Volume Agents (Cashout) — Postgres (balanceService.ts's
    // getAgentBalances, cashoutAgentBalances fetched above), not the
    // "Opening AG" roster merged with per-agent Sheets maps. companyBalance
    // already IS opening+DP+topUp-WD-settlement (balanceEngine.ts's own
    // formula), the same runningBalance this section always computed by
    // hand.
    const cashoutAgentRows: AgentRow[] = cashoutAgentBalances.map((agent) => ({
      agentName: agent.agentCode,
      opening: agent.openingBalance,
      runningBalance: agent.companyBalance,
      totalDP: agent.totalDp,
      balanceInside: agent.balanceInside,
    }));

    const cashoutTop50Agents = cashoutAgentRows
      .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
      .sort((a, b) => (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
      .slice(0, 50);

    // CashGo Trend — 7 days ending yesterday (today excluded, in progress),
    // plus today's own figure separately for the progress bar. PostgreSQL-
    // backed (daily_txn_cashgo_entry, via Daily Transaction Entry's CashGo
    // tab) — each business date has 2 rows (bkash/nagad), folded into one
    // map entry per date here to match the shape buildDaySeries/
    // latestActivityDay below already expect.
    const cashGoByDate = new Map<string, { bk: number; ng: number; bkQuota: number; ngQuota: number }>();
    cashGoHistoryRows.forEach((row) => {
      const [y, m, d] = row.businessDate.split('-').map(Number);
      const key = dateKey(manilaMidnight(y, m - 1, d));
      const entry = cashGoByDate.get(key) ?? { bk: 0, ng: 0, bkQuota: 0, ngQuota: 0 };
      if (row.channel === 'bkash') {
        entry.bk = row.process ?? 0;
        entry.bkQuota = row.target ?? 0;
      } else {
        entry.ng = row.process ?? 0;
        entry.ngQuota = row.target ?? 0;
      }
      cashGoByDate.set(key, entry);
    });

    const yesterday = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
    const emptyCashGo = { bk: 0, ng: 0, bkQuota: 0, ngQuota: 0 };
    const cashGoPoint = (date: string, t: typeof emptyCashGo) => ({ date, bkash: round2(t.bk / M), nagad: round2(t.ng / M) });
    const cashoutChart = buildDaySeries(cashGoByDate, emptyCashGo, 7, yesterday, cashGoPoint);
    const cashoutChart30 = buildDaySeries(cashGoByDate, emptyCashGo, 30, yesterday, cashGoPoint);
    const cashoutTodayResult = latestActivityDay(cashGoByDate, cutoff, emptyCashGo, 32, (t) => t.bk + t.ng > 0);
    const cashoutToday = cashoutTodayResult.data;
    const cashoutProgressLabel = cashoutTodayResult.date.getTime() === cutoff.getTime() ? 'Today' : formatShortDateLabel(cashoutTodayResult.date);

    const cashoutDataRows = cashoutWallets.filter((r) => r.wallet.toLowerCase() !== 'total');
    const cashoutTotalDP = cashoutDataRows.reduce((s, r) => s + r.totalDP, 0);
    const cashoutTotalWD = cashoutDataRows.reduce((s, r) => s + Math.abs(r.totalWD), 0);
    const cashoutTotalWDSigned = cashoutDataRows.reduce((s, r) => s + r.totalWD, 0);
    const cashoutTotalTopUp = cashoutDataRows.reduce((s, r) => s + r.bdTransferIn, 0);
    const cashoutTotalStlm = cashoutDataRows.reduce((s, r) => s + r.stlm, 0);
    const cashoutActualTotal = cashoutDataRows.reduce((s, r) => s + r.actualBal, 0);
    const cashoutRunningTotal = cashoutDataRows.reduce((s, r) => s + r.runningBal, 0);
    const cashoutVsOpening = cashoutRunningTotal - cashoutOpeningEffective;

    // Top Performer Wallet (Cashout) — simple net gain per wallet, no BD/
    // Bkash segregation (that's Send Money-only, see below). Ported
    // verbatim from app/balance-overview/page.tsx's walletGainRanking.
    const cashoutWalletGainRanking: TopPerformerRow[] = cashoutDataRows
      .map((row) => ({ wallet: row.wallet, gain: row.totalDP + row.totalWD, actualBal: row.actualBal }))
      .sort((a, b) => a.gain - b.gain);

    // ---------- Send Money ----------
    const sendMoneyWallets = parseWalletSheetRows(sendMoneySheetRows);

    // Postgres (sum of getAgentBalances' own per-agent openingBalance), not
    // "Opening AG" col O (idx 12) summed by hand — same figure, same roster.
    const sendMoneyOpeningSum = sendMoneyAgentBalances.reduce((sum, a) => sum + a.openingBalance, 0);
    const sendMoneyOpeningEffective = sendMoneyOpeningOverride ?? sendMoneyOpeningSum;

    // Wallet-type DP/WD, split into WITH (feeds the Wallet Summary ledger)
    // and WITHOUT BD-keyword shops (feeds Top Performer Wallet only) — BD's
    // own DP/WD/Balance gets its own separate synthetic "Bundle Deposit"
    // line. Postgres (agent_wallets via getAgentWalletRawRows), not "SSP PS
    // BalanceLimit" — walletTypeCode here is the DB's own stored wallet
    // type (confirmed populated for every Send Money row, same as Cashout,
    // not re-derived from the agent name suffix the sheet-reading code had
    // to do). Per-agent DP/WD/Balance Inside for High Volume Agents no
    // longer needs deriving here at all — getAgentBalances
    // (sendMoneyAgentBalances, fetched above) already computes those same
    // figures per-agent server-side.
    const sendMoneyWalletDP = new Map<string, number>();
    const sendMoneyWalletWD = new Map<string, number>();
    const walletDPNonBD = new Map<string, number>();
    const walletWDNonBD = new Map<string, number>();
    let bdKeywordDP = 0;
    let bdKeywordWD = 0;
    let bdKeywordBalance = 0;
    sendMoneyAgentWalletRaw.forEach((row) => {
      const label = row.walletTypeCode;
      const isBdKeyword = row.agentCode.toUpperCase().includes('BD');
      if (label) {
        sendMoneyWalletDP.set(label, (sendMoneyWalletDP.get(label) ?? 0) + row.totalDp);
        sendMoneyWalletWD.set(label, (sendMoneyWalletWD.get(label) ?? 0) + row.totalWd);
        if (!isBdKeyword) {
          walletDPNonBD.set(label, (walletDPNonBD.get(label) ?? 0) + row.totalDp);
          walletWDNonBD.set(label, (walletWDNonBD.get(label) ?? 0) + row.totalWd);
        }
      }
      if (isBdKeyword) {
        bdKeywordDP += row.totalDp;
        bdKeywordWD += row.totalWd;
        bdKeywordBalance += row.balance;
      }
    });

    const sendMoneyWalletTopUp = new Map<string, number>();
    const sendMoneyWalletStlm = new Map<string, number>();
    const bundleByDate = new Map<string, { NAGAD: number; ROCKET: number; UPAY: number }>();

    // Top Up/Settlement (Wallet Summary columns) + Bundle Transfer Trend —
    // both read the same wallet_transactions rows (see
    // getSendMoneyTransactionsSince's own header comment for why this
    // replaced the "PS BD STLM + TOPUP" sheet fetch). Settlement IS Bundle
    // Transfer for Send Money (every Settlement-type row's sheet-era Type
    // was literally "BUNDLE TRANSFER" — see CLAUDE.md), so a settlement row
    // feeds both the wallet Settlement total (cutoff-filtered, like Top Up)
    // and the trend chart (unfiltered by cutoff). Per-agent Top Up/
    // Settlement no longer needs deriving here — getAgentBalances
    // (sendMoneyAgentBalances, fetched above) already has those per-agent.
    sendMoneyTransactions.forEach((txn) => {
      if (!txn.amount) return;
      const wallet = (txn.wallet ?? '').trim().toUpperCase();
      const date = parseIsoDateManila(txn.occurredOn);
      if (!date) return;

      if (txn.transactionType === 'topup') {
        if (date >= sendMoneyLiveCutoff && wallet) {
          sendMoneyWalletTopUp.set(wallet, (sendMoneyWalletTopUp.get(wallet) ?? 0) + txn.amount);
        }
        return;
      }

      // transactionType === 'settlement'
      if (date >= sendMoneyLiveCutoff && wallet) {
        sendMoneyWalletStlm.set(wallet, (sendMoneyWalletStlm.get(wallet) ?? 0) + txn.amount);
      }
      if (wallet === 'NAGAD' || wallet === 'ROCKET' || wallet === 'UPAY') {
        const key = dateKey(date);
        const existing = bundleByDate.get(key) ?? { NAGAD: 0, ROCKET: 0, UPAY: 0 };
        existing[wallet as 'NAGAD' | 'ROCKET' | 'UPAY'] += txn.amount;
        bundleByDate.set(key, existing);
      }
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

    // High Volume Agents (Send Money) — Postgres (balanceService.ts's
    // getAgentBalances, sendMoneyAgentBalances fetched above), not the
    // "Opening AG" roster merged with per-agent Sheets maps. companyBalance
    // already includes the widened-cutoff Top Up/Settlement window
    // (computeTopUpSettlementCutoff in balanceService.ts), matching what
    // this section always computed for Send Money by hand.
    const sendMoneyAgentRows: AgentRow[] = sendMoneyAgentBalances.map((agent) => ({
      agentName: agent.agentCode,
      opening: agent.openingBalance,
      runningBalance: agent.companyBalance,
      totalDP: agent.totalDp,
      balanceInside: agent.balanceInside,
    }));

    const sendMoneyTop50Agents = sendMoneyAgentRows
      .filter((agent) => agent.totalDP > 0 && agent.runningBalance > 30000 && agent.runningBalance - agent.opening > 0)
      .sort((a, b) => (b.runningBalance - b.opening) - (a.runningBalance - a.opening))
      .slice(0, 50);

    const emptyBundle = { NAGAD: 0, ROCKET: 0, UPAY: 0 };
    const bundlePoint = (date: string, t: typeof emptyBundle) => ({ date, nagad: round2(t.NAGAD / M), rocket: round2(t.ROCKET / M), upay: round2(t.UPAY / M) });
    const sendMoneyChart = buildDaySeries(bundleByDate, emptyBundle, 7, yesterday, bundlePoint);
    const sendMoneyChart30 = buildDaySeries(bundleByDate, emptyBundle, 30, yesterday, bundlePoint);
    const sendMoneyTodayResult = sumActivitySinceLastUpdate(bundleByDate, cutoff, emptyBundle, 32, (t) => t.NAGAD + t.ROCKET + t.UPAY > 0);
    const sendMoneyTodayBundle = sendMoneyTodayResult.data;
    const sendMoneyTodayTotal = sendMoneyTodayBundle.NAGAD + sendMoneyTodayBundle.ROCKET + sendMoneyTodayBundle.UPAY;
    const sendMoneyProgressLabel = sendMoneyTodayResult.date.getTime() === cutoff.getTime() ? 'Today' : formatShortDateLabel(sendMoneyTodayResult.date);

    const sendMoneyDataRows = sendMoneyWallets.filter((r) => r.wallet.toUpperCase() !== 'TOTAL');
    const sendMoneyTotalDP = sendMoneyDataRows.reduce((s, r) => s + r.totalDP, 0);
    const sendMoneyTotalWD = sendMoneyDataRows.reduce((s, r) => s + Math.abs(r.totalWD), 0);
    const sendMoneyTotalWDSigned = sendMoneyDataRows.reduce((s, r) => s + r.totalWD, 0);
    const sendMoneyTotalTopUp = sendMoneyDataRows.reduce((s, r) => s + r.bdTransferIn, 0);
    const sendMoneyTotalStlm = sendMoneyDataRows.reduce((s, r) => s + r.stlm, 0);
    const sendMoneyActualTotal = sendMoneyDataRows.reduce((s, r) => s + r.actualBal, 0);
    const sendMoneyRunningTotal = sendMoneyDataRows.reduce((s, r) => s + r.runningBal, 0);
    const sendMoneyVsOpening = sendMoneyRunningTotal - sendMoneyOpeningEffective;

    // Top Performer Wallet (Send Money) — BD-keyword shops stripped out of
    // each wallet's own gain and broken out as their own "Bundle Deposit"
    // line. Bkash included per explicit request (confirmed fully supported:
    // walletDPNonBD/walletWDNonBD above already track a BKASH entry the
    // same way as NAGAD/ROCKET/UPAY, via the DB's own stored wallet type
    // code (BKASH included) — the exclusion below was purely a
    // display-level filter, not a real data gap, same root cause as the
    // Wallet Breakdown "Coming soon" fix).
    const sendMoneyWalletGainRanking: TopPerformerRow[] = sendMoneyDataRows
      .map((row) => {
        const label = row.wallet.toUpperCase();
        // Matches app/sendmoney/page.tsx's own nonBdGain map exactly: every
        // wallet-type key is pre-initialized to 0 (not left undefined) when
        // it has no non-BD activity, so the `?? (totalDP +
        // totalWD)` fallback in that page's own source is effectively dead
        // for NAGAD/ROCKET/UPAY/BKASH — reproduced here as a plain 0-default
        // rather than re-adding that unreachable fallback.
        const nonBdGain = (walletDPNonBD.get(label) ?? 0) - (walletWDNonBD.get(label) ?? 0);
        return { wallet: row.wallet, gain: nonBdGain, actualBal: row.actualBal };
      })
      .concat([{ wallet: 'Bundle Deposit', gain: bdKeywordDP - bdKeywordWD, actualBal: bdKeywordBalance }])
      .sort((a, b) => a.gain - b.gain);

    // ---------- Running Balance by Brand (SSP Line 1 / SSP Line 2) ----------
    // Static Opening/Deposit/Withdrawal/Total from the "Brand Balance"
    // sheet, Top Up/Settlement live from Postgres (Phase 10, brand_id-
    // scoped) — same source app/page.tsx's SspLine1Section uses, NOT
    // app/balance-overview/page.tsx's older agstlmtopup-derived version.
    const [sspTopUpStlmRows, sspTopUpStlmSendMoneyRows, cashoutBalanceLimitLastImport, sendMoneyBalanceLimitLastImport] = await Promise.all([
      getSspLine1TopUpSettlement('cashout', formatCutoffDateKey(cashoutLiveCutoff)),
      getSspLine1TopUpSettlement('sendmoney', formatCutoffDateKey(sendMoneyLiveCutoff)),
      // Today's Insights cards' own "Last Update" indicator — Ending
      // Balance there is the same Company Balance figure the Balance page
      // shows, driven by this same Balance Limit upload; same signal, same
      // per-product source, per explicit instruction.
      getBalanceLimitLastImport('cashout'),
      getBalanceLimitLastImport('sendmoney'),
    ]);
    const cashoutBrandTopUpStlm = new Map(sspTopUpStlmRows.map((r) => [r.brand.toUpperCase(), { topUp: r.topUp, stlm: r.settlement }]));
    const sendMoneyBrandTopUpStlm = new Map(sspTopUpStlmSendMoneyRows.map((r) => [r.brand.toUpperCase(), { topUp: r.topUp, stlm: r.settlement }]));

    // Cashout's own Total stays reading the sheet's own static column
    // unchanged (its brand attribution never changed, so it still
    // reconciles) — matches app/page.tsx's sspLine1CashoutComputed exactly.
    const cashoutBrandBalance: BrandBalanceRow[] = ssp1LedgerRows.map((row) => {
      const t = cashoutBrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
      return {
        brand: row.brand,
        topUp: t.topUp,
        settlement: -t.stlm,
        staticOpening: row.opening,
        staticDeposit: row.deposit,
        staticWithdrawal: row.withdrawal,
        staticTotal: row.total,
      };
    });

    // Send Money's own Total is recomputed live instead (its static Total
    // predates the brand-basis fix and no longer agrees with the live
    // per-brand split) — matches app/page.tsx's sspLine1SendMoneyComputed.
    const sendMoneyBrandBalance: BrandBalanceRow[] = ssp2LedgerRows.map((row) => {
      const t = sendMoneyBrandTopUpStlm.get(row.brand.toUpperCase()) ?? { topUp: 0, stlm: 0 };
      const settlement = -t.stlm;
      return {
        brand: row.brand,
        topUp: t.topUp,
        settlement,
        staticOpening: row.opening,
        staticDeposit: row.deposit,
        staticWithdrawal: row.withdrawal,
        staticTotal: row.opening + row.deposit - row.withdrawal + t.topUp + settlement,
      };
    });

    // ---------- Cash In Hand ----------
    // "Exactly one source" reconciliation, same as app/page.tsx: sspAg/
    // sspPs are NOT trusted from the sheet's own columns — they're
    // cross-referenced onto Running Balance by Brand's own per-brand
    // staticTotal above (Cashout's own = the sheet's static Total, Send
    // Money's own = the live-recomputed Total, per each product's own rule
    // just above), and totalBrandCIH is recomputed from those plus
    // ESS/Autopay/Expay so it can't silently drift from its own inputs.
    const cashoutTotalByBrand = new Map(cashoutBrandBalance.map((row) => [row.brand.toUpperCase(), row.staticTotal]));
    const sendMoneyTotalByBrand = new Map(sendMoneyBrandBalance.map((row) => [row.brand.toUpperCase(), row.staticTotal]));

    // Ess/Autopay/Expay — same Daily Txn Entry ledger source as SSP Line 1&2
    // above (ledgerId 'ess'/'atp'/'expay'), each card's own per-brand Total.
    const essByBrand = new Map(essLedgerRows.map((r) => [r.brand.toUpperCase(), r.total]));
    const atpByBrand = new Map(atpLedgerRows.map((r) => [r.brand.toUpperCase(), r.total]));
    const expayByBrand = new Map(expayLedgerRows.map((r) => [r.brand.toUpperCase(), r.total]));

    const cashInHandRows: CashInHandRow[] = DAILY_TXN_LEDGER_BRANDS.map((brand) => {
      const key = brand.toUpperCase();
      const sspAg = cashoutTotalByBrand.get(key) ?? 0;
      const sspPs = sendMoneyTotalByBrand.get(key) ?? 0;
      const ess = essByBrand.get(key) ?? 0;
      const autopay = atpByBrand.get(key) ?? 0;
      const expay = expayByBrand.get(key) ?? 0;
      return {
        brand,
        sspAg,
        sspPs,
        ess,
        autopay,
        autopaySupported: !AUTOPAY_UNSUPPORTED_BRANDS.includes(key),
        expay,
        totalBrandCIH: sspAg + sspPs + ess + autopay + expay,
      };
    });

    // No sheet "TOTAL PG CIH" row exists in the ledger-based world — every
    // column here is already a real per-brand figure, so the total is just
    // their sum, not a separately-sourced manual figure.
    const cashInHandTotal: CashInHandRow = {
      brand: 'TOTAL PG CIH',
      sspAg: cashInHandRows.reduce((s, r) => s + r.sspAg, 0),
      sspPs: cashInHandRows.reduce((s, r) => s + r.sspPs, 0),
      ess: cashInHandRows.reduce((s, r) => s + r.ess, 0),
      autopay: cashInHandRows.reduce((s, r) => s + r.autopay, 0),
      autopaySupported: true,
      expay: cashInHandRows.reduce((s, r) => s + r.expay, 0),
      totalBrandCIH: cashInHandRows.reduce((s, r) => s + r.totalBrandCIH, 0),
    };

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

    const toOverviewWallets = (walletRows: WalletRow[]) =>
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
        openingTrend: toOpeningTrendPoints(openingTrendCashout),
        wallets: toLedgerWallets(cashoutWallets),
        overview: {
          opening: cashoutOpeningEffective,
          deposit: cashoutTotalDP,
          withdrawal: cashoutTotalWDSigned,
          topup: cashoutTotalTopUp,
          settlement: cashoutTotalStlm,
          ending: cashoutRunningTotal,
          endingChange: cashoutVsOpening,
          progressValue: round2((cashoutToday.bk + cashoutToday.ng) / M),
          progressQuota: round2((cashoutToday.bkQuota + cashoutToday.ngQuota) / M) || undefined,
          progressLabel: cashoutProgressLabel,
          todayWallets: [
            { name: 'Bkash', value: round2(cashoutToday.bk / M), quota: round2(cashoutToday.bkQuota / M) || undefined },
            { name: 'Nagad', value: round2(cashoutToday.ng / M), quota: round2(cashoutToday.ngQuota / M) || undefined },
          ],
          wallets: toOverviewWallets(cashoutWallets),
          lastUpdate: cashoutBalanceLimitLastImport?.completedAt ?? null,
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
        openingTrend: toOpeningTrendPoints(openingTrendSendMoney),
        wallets: toLedgerWallets(sendMoneyWallets),
        overview: {
          opening: sendMoneyOpeningEffective,
          deposit: sendMoneyTotalDP,
          withdrawal: sendMoneyTotalWDSigned,
          topup: sendMoneyTotalTopUp,
          settlement: sendMoneyTotalStlm,
          ending: sendMoneyRunningTotal,
          endingChange: sendMoneyVsOpening,
          progressValue: round2(sendMoneyTodayTotal / M),
          progressQuota: round2(sendMoneyTodayTotal / M) || undefined,
          progressLabel: sendMoneyProgressLabel,
          todayWallets: [
            { name: 'Nagad', value: round2(sendMoneyTodayBundle.NAGAD / M) },
            { name: 'Rocket', value: round2(sendMoneyTodayBundle.ROCKET / M) },
            { name: 'Upay', value: round2(sendMoneyTodayBundle.UPAY / M) },
          ].filter((w) => w.value > 0),
          wallets: toOverviewWallets(sendMoneyWallets),
          lastUpdate: sendMoneyBalanceLimitLastImport?.completedAt ?? null,
        },
      },
      // Top Performer Wallet, per product — ascending by net gain (DP+WD,
      // signed). See cashoutWalletGainRanking/sendMoneyWalletGainRanking above.
      topPerformers: {
        cashout: cashoutWalletGainRanking,
        sendmoney: sendMoneyWalletGainRanking,
      },
      // High Volume Agents (top 50 by running-balance-vs-opening delta),
      // per product. See cashoutTop50Agents/sendMoneyTop50Agents above.
      agents: {
        cashout: cashoutTop50Agents,
        sendmoney: sendMoneyTop50Agents,
      },
      // Running Balance by Brand ("SSP Line 1" Cashout / "SSP Line 2" Send
      // Money) — static*/topUp/settlement split documented on BrandBalanceRow.
      brandBalance: {
        cashout: cashoutBrandBalance,
        sendmoney: sendMoneyBrandBalance,
      },
      // Cash In Hand — sspAg/sspPs already reconciled from brandBalance's
      // own live totals (see comment above); rows + column-totals footer.
      cashInHand: {
        rows: cashInHandRows,
        total: cashInHandTotal,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build dashboard data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
