// Opening-resolution cascade for Daily Txn Entry's "Wallet Breakdown
// Estimated" card (app/api/daily-txn-entry/estimated/route.ts) — split out
// of that route file because Next.js's app-router route files may only
// export recognized route handlers (GET/POST/etc.) and a small fixed set of
// config values; any other export fails the build's own route-shape check.
// Also lets scripts/verify-estimated-cascade.ts unit-test this logic in
// isolation with constructed data, without writing anything to the live DB.
import {
  readEstimatedOpeningWalletTotalsForCutoffRange,
  type EstimatedOpeningWalletTotals,
} from '@/app/lib/db/read/estimatedOpening';
import { getDailyTxnWalletClosingRange, getLatestDailyTxnWalletClosing, getDailyTxnWalletClosing } from '@/app/lib/db/read/dailyTxnWalletClosing';

export const PG_WALLETS = ['Bkash', 'Nagad', 'Rocket', 'UPay'] as const;
// UNMAPPED is a valid key in the stored wallet-totals data (see
// estimatedOpeningService.ts) but is deliberately absent from this map —
// resolveWalletOpening/walletTypeCards below only ever look up wallet totals
// via WALLET_TO_KEY[wallet] for a real PG_WALLETS member, so an 'UNMAPPED'
// bucket can never be looked up as if it were a wallet's own Opening/DP/WD —
// it only ever reaches the response via the caller's own separate `unmapped`
// field (see estimated/route.ts).
export const WALLET_TO_KEY: Record<(typeof PG_WALLETS)[number], string> = {
  Bkash: 'BKASH',
  Nagad: 'NAGAD',
  Rocket: 'ROCKET',
  UPay: 'UPAY',
};

export type OpeningSource = 'confirmed' | 'estimated' | 'carry-forward';
export type OpeningResolution = { amount: number; source: OpeningSource; sourceDate: string };

// Pure calendar-day arithmetic on an already-resolved 'YYYY-MM-DD' string —
// no timezone conversion needed here (unlike the caller's own "yesterday"
// derivation, which anchors "now" to the Manila business day): once we have
// a business-date string, walking it back N days is just date math.
export function subtractDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d - days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

// Retention on daily_txn_wallet_closing_entry is 1 week and
// estimated_balance_uploads realistically has at most a handful of gap-days
// between confirmations — 60 is a generous safety cap against an unbounded
// recursive walk-back, never expected to actually bind in practice. Also
// sizes the batch-fetch window below (CASCADE_WINDOW_DAYS).
export const MAX_CASCADE_DEPTH = 60;
const CASCADE_WINDOW_DAYS = MAX_CASCADE_DEPTH;

// Pre-fetched inputs for resolveWalletOpening — one query for confirmed
// closings and one for upload wallet-totals, covering the WHOLE date window
// this request could possibly need, instead of a query per recursion level
// (per explicit instruction). Built once per GET, reused across all 4
// wallets and every recursion depth.
export type CascadeData = {
  // dateStr -> wallet -> confirmed amount
  confirmedByDate: Map<string, Map<string, number>>;
  // dateStr -> walletType (BKASH/NAGAD/ROCKET/UPAY/UNMAPPED) -> totals
  uploadsByDate: Map<string, Map<string, EstimatedOpeningWalletTotals>>;
};

export async function fetchCascadeData(ledgerId: 'ssp1' | 'ssp2', product: 'cashout' | 'sendmoney', latestDate: string): Promise<CascadeData> {
  const windowStart = subtractDays(latestDate, CASCADE_WINDOW_DAYS);
  const [confirmedRows, uploadsByDate] = await Promise.all([
    getDailyTxnWalletClosingRange(ledgerId, windowStart, latestDate),
    readEstimatedOpeningWalletTotalsForCutoffRange(product, windowStart, latestDate),
  ]);

  const confirmedByDate = new Map<string, Map<string, number>>();
  for (const r of confirmedRows) {
    if (r.amount === null) continue;
    if (!confirmedByDate.has(r.businessDate)) confirmedByDate.set(r.businessDate, new Map());
    confirmedByDate.get(r.businessDate)!.set(r.wallet, r.amount);
  }

  return { confirmedByDate, uploadsByDate };
}

// The Opening for day X, per explicit 3-tier spec:
//   1. Confirmed closing tagged exactly X (daily_txn_wallet_closing_entry) —
//      a real, manually-observed figure, used as-is, no addition.
//   2. Else: X's own opening, unconfirmed, is estimated as
//      [the SAME resolver applied to (X-1)] + [(X-1)'s own uploaded
//      Total DP/WD/Topup/Settlement] — i.e. one full day's worth of that
//      earlier day's activity rolled forward. X's OWN upload gets applied
//      exactly once, by the CALLER of this function (estimated/route.ts's
//      own walletTypeCards / dashboard's computeWalletEstimates), never
//      inside this function — using (X-1)'s activity here, not X's, is what
//      keeps that from double-counting.
//
//      Looking up "(X-1)'s own upload" means finding the upload whose data
//      covers day X-1 — per explicit decision, estimated_balance_uploads.
//      cutoff_date now stores the UPLOAD's own Manila business date, not the
//      date its DP/WD data represents (that data date is always cutoff_date
//      minus one calendar day, since a file is uploaded the business day
//      after the day it reports on). So "the upload covering X-1" is found
//      at cutoffDate = X, not X-1 — the lookup key shifted by a day in the
//      SAME direction cutoff_date's own meaning shifted, while the
//      dimensional equation itself (baseline-from-X-1 + that day's own
//      activity) is unchanged. Concretely: resolving Sep 27's Opening looks
//      up an upload with cutoffDate=Sep 27 (uploaded the morning of the
//      27th, reporting the 26th's activity) to get Sep 26's own estimate,
//      whose baseline in turn recurses into Sep 26's own Opening.
//   3. Else: carry forward to the latest confirmed closing on/before X.
//      (This one tier still hits the DB directly — getLatestDailyTxnWalletClosing
//      — since it needs "on or before" semantics the batch window's exact-date
//      map doesn't capture; it's the rarest branch, only reached once the
//      whole window has neither a confirmed nor an estimated value.)
// A confirmed closing always wins over an estimate even if the estimate is
// "newer" — Tier 1 is checked first at every recursion level, per explicit
// rule. Pure function of CascadeData + current DB state (no caching, no
// writes) — see estimated/route.ts's own header comment on why "D-1's card"
// and "D's Opening" can never drift apart: neither is stored, both recompute
// from the same source every time.
export async function resolveWalletOpening(
  ledgerId: 'ssp1' | 'ssp2',
  wallet: (typeof PG_WALLETS)[number],
  dateStr: string,
  data: CascadeData,
  depth = 0
): Promise<OpeningResolution> {
  const confirmed = data.confirmedByDate.get(dateStr)?.get(wallet);
  if (confirmed !== undefined) {
    return { amount: confirmed, source: 'confirmed', sourceDate: dateStr };
  }

  if (depth < MAX_CASCADE_DEPTH) {
    const prevDateStr = subtractDays(dateStr, 1);
    // Upload lookup keys on dateStr (X) itself, NOT prevDateStr (X-1) — see
    // this function's own header comment: cutoff_date now means "uploaded
    // on this business day", so the upload covering X-1's activity is the
    // one whose cutoff_date equals X.
    const t = data.uploadsByDate.get(dateStr)?.get(WALLET_TO_KEY[wallet]);
    if (t) {
      const baseline = await resolveWalletOpening(ledgerId, wallet, prevDateStr, data, depth + 1);
      const amount = baseline.amount + t.totalDP - t.totalWD + (t.topUp ?? 0) - (t.settlement ?? 0);
      return { amount, source: 'estimated', sourceDate: dateStr };
    }
  }

  // Falls outside the batch window (or the window genuinely has nothing) —
  // one direct query, the rare/last-resort path.
  const carriedRows = await getLatestDailyTxnWalletClosing(ledgerId, dateStr);
  const carried = carriedRows.find((r) => r.wallet === wallet);
  return { amount: carried?.amount ?? 0, source: 'carry-forward', sourceDate: carried?.businessDate ?? dateStr };
}

export type WalletEstimate = {
  wallet: (typeof PG_WALLETS)[number];
  opening: number;
  openingSource: OpeningSource;
  openingSourceDate: string;
  totalDp: number | null;
  totalWd: number | null;
  settlement: number | null;
  topup: number | null;
  // Opening + totalDp - totalWd + topup - settlement — null only when this
  // wallet has no upload data at all (walletTotals has no entry for it).
  amount: number | null;
};

// The single shared per-wallet Estimated computation — used by BOTH the
// Estimated tab (app/api/daily-txn-entry/estimated/route.ts) and the main
// Dashboard (app/api/dashboard/route.ts), per explicit instruction that the
// dashboard's Opening/Ending Balance must be driven by the same cascade, not
// a second copy of this formula. `walletTotals` is the caller's own latest-
// upload map (from readEstimatedOpeningDisplayPg or readEstimatedOpeningPg) —
// passed in rather than fetched here so a caller that already has it (both
// current callers do) doesn't re-fetch it.
export async function computeWalletEstimates(
  ledgerId: 'ssp1' | 'ssp2',
  product: 'cashout' | 'sendmoney',
  yesterday: string,
  walletTotals: Map<string, EstimatedOpeningWalletTotals>,
  // TODAY's own confirmed closing (Report tab's "Yesterday Closing" card,
  // saved under TODAY's businessDate — yesterday's closing IS today's
  // opening) taking effect immediately is a Dashboard-only behavior (per
  // explicit instruction: Today's Insights shouldn't wait until tomorrow's
  // cascade run to reflect a same-day confirmation). The Estimated tab's own
  // Wallet Breakdown card keeps the ORIGINAL rule instead — a fresh same-day
  // entry must never become its own estimate's baseline (see
  // resolveWalletOpening's own header comment), so that card can always be
  // read as "yesterday's Opening + yesterday's own DP/WD/Settlement/TopUp",
  // consistent regardless of what's been confirmed today. Sharing one
  // function with a flag (not two copies) per this file's own "one shared
  // computation" principle — only Tier-0 (today) differs, everything else
  // (Tier 1-3 inside resolveWalletOpening) is identical for both callers.
  useTodayConfirmed = false,
  // The upload `walletTotals` actually came from (readEstimatedOpeningDisplayPg's
  // own uploadCutoffDate) — null if there's no upload at all. Confirmed live:
  // without this check, a stale upload (no fresh file yet for today, e.g.
  // right after the 2AM business-day rollover) still had its DP/WD/
  // Settlement/Topup silently applied here, blended with a correctly-dated
  // Opening baseline from resolveWalletOpening's own per-date cascade below —
  // two different dates' numbers combined into one card with no indication
  // anything was stale. The fix: only trust `walletTotals` when its own
  // cutoff date actually IS today.
  uploadCutoffDate: string | null = null
): Promise<WalletEstimate[]> {
  const today = subtractDays(yesterday, -1);
  const walletTotalsAreForToday = uploadCutoffDate === today;
  const [cascadeData, todayConfirmedRows] = await Promise.all([
    fetchCascadeData(ledgerId, product, yesterday),
    useTodayConfirmed ? getDailyTxnWalletClosing(ledgerId, today) : Promise.resolve([]),
  ]);
  const todayConfirmedByWallet = new Map(
    todayConfirmedRows.filter((r): r is typeof r & { amount: number } => r.amount !== null).map((r) => [r.wallet, r.amount])
  );

  return Promise.all(
    PG_WALLETS.map(async (wallet) => {
      const todayConfirmed = todayConfirmedByWallet.get(wallet);
      const t = walletTotalsAreForToday ? walletTotals.get(WALLET_TO_KEY[wallet]) : undefined;
      if (todayConfirmed !== undefined) {
        // amount stays the confirmed value as-is (no addition — the
        // confirmed figure already reflects yesterday's activity, adding t
        // on top would double-count it). totalDp/totalWd/settlement/topup
        // still show t's real figures though — informational display only,
        // not part of the arithmetic — so the card doesn't go blank just
        // because Opening happened to come from a confirmed entry today.
        return {
          wallet,
          opening: todayConfirmed,
          openingSource: 'confirmed' as const,
          openingSourceDate: today,
          totalDp: t?.totalDP ?? null,
          totalWd: t?.totalWD ?? null,
          settlement: t?.settlement ?? null,
          topup: t?.topUp ?? null,
          amount: todayConfirmed,
        };
      }

      const resolution = await resolveWalletOpening(ledgerId, wallet, yesterday, cascadeData);
      const opening = resolution.amount;
      const amount = t ? opening + t.totalDP - t.totalWD + (t.topUp ?? 0) - (t.settlement ?? 0) : null;
      return {
        wallet,
        opening,
        openingSource: resolution.source,
        openingSourceDate: resolution.sourceDate,
        totalDp: t?.totalDP ?? null,
        totalWd: t?.totalWD ?? null,
        settlement: t?.settlement ?? null,
        topup: t?.topUp ?? null,
        amount,
      };
    })
  );
}
