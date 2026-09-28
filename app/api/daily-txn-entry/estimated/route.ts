import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { readEstimatedOpeningDisplayPg, type EstimatedOpeningWalletTotals } from '@/app/lib/db/read/estimatedOpening';
import { computeWalletEstimates } from '@/app/lib/services/estimatedWalletCascade';

// Daily Txn Entry's own "Estimated" tab (4th tab, alongside Operations/
// Report/CashGo) — READ-ONLY. Per explicit instruction, there is no upload
// here: the single upload point stays the Balance page's own "Estimate
// Balance" / "Bulk Import Opening Balance Accounts" modal
// (app/api/opening/upload-estimated-balance, app/api/sendmoney/opening/
// upload-estimated-balance). This route just wires that SAME upload's
// latest result — readEstimatedOpeningDisplayPg, the same reader the
// Balance pages' own GET /api/{opening,sendmoney/opening}/estimated-balance
// routes and the Dashboard's own Estimated Opening override already use —
// into this tab's two containers:
//   - Wallet Breakdown Estimated: per-wallet Estimated = Opening + uploaded
//     Total DP − uploaded Total WD + uploaded Topup − uploaded Settlement.
//     Sign convention for Topup/Settlement (+Topup, −Settlement) matches
//     estimatedOpeningService.ts's own documented formula and
//     balanceEngine.ts's computeCompanyBalance() — both already established
//     wallet_transactions.amount as a positive magnitude requiring
//     subtraction for Settlement, addition for Topup. Settlement/Topup are
//     nullable (NULL = "not captured", every upload row written before that
//     column existed) — treated as 0 for this arithmetic only; the UI shows
//     NULL as "—", not "0.00".
//
//     Opening itself is resolved via resolveWalletOpening() (app/lib/services/
//     estimatedWalletCascade.ts, split out there because route files may only
//     export recognized route handlers) — a 3-tier cascade (confirmed closing
//     → the SAME resolver applied one day further back, combined with that
//     earlier day's own upload → carry forward), per explicit spec.
//     Deliberately excludes TODAY's own entry as the baseline — same
//     reasoning as Estimated Opening (Each Shop)'s own previousOpeningBalance:
//     a fresh same-day entry must never become its own estimate's baseline,
//     so today's figure can be sanity-checked against what this card already
//     shows instead of silently replacing it.
//     Nothing about the resolved Opening chain is ever stored/cached — only
//     the raw per-upload DP/WD/Settlement/Topup snapshot is frozen. Every
//     call to resolveWalletOpening recomputes fresh from CURRENT
//     daily_txn_wallet_closing_entry state, so there is no separate "stored
//     Estimated" that could drift from what a later day's Opening uses —
//     they're the same function call, same inputs, always.
//   - Estimated Opening (Each Shop): balancesWithFallback — every roster
//     shop, using the actual uploaded figure where the shop was in the
//     file, falling back to opening+topUp−settlement otherwise. Same value
//     the Dashboard's own KPI override sums, not the upload-only `balances`
//     map, so this matches what's shown elsewhere in the app.
//
// ledgerId 'ssp1' = Cashout, 'ssp2' = Send Money (see daily-txn-entry/
// page.tsx's own LEDGERS titles — this mapping is established there).
// This route previously wrote to its own dedicated upload tables
// (dailyTxnWalletBreakdownUploads/...Totals/dailyTxnEstimatedOpeningEntries)
// — removed per explicit follow-up instruction to consolidate uploading
// back onto the Balance page's single existing modal; those tables have
// been dropped (see drizzle/ for the migration).

// N business days before today, as 'YYYY-MM-DD' — Manila business-day
// boundary (2 AM reset, see businessDate.ts), NOT server UTC or raw
// wall-clock. daysAgoStr(1) is "yesterday", the Wallet Breakdown Estimated
// card's own baseline date. Not reused for shopRows/walletRows below: those
// already carry their own previousOpeningBalance baseline from
// readEstimatedOpeningDisplayPg.
function daysAgoStr(n: number): string {
  const d = new Date(getBusinessToday().getTime() - n * 24 * 60 * 60 * 1000);
  const { year, month, day } = manilaFields(d);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidLedgerId(v: unknown): v is 'ssp1' | 'ssp2' {
  return v === 'ssp1' || v === 'ssp2';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ledgerId = url.searchParams.get('ledgerId');
  if (!isValidLedgerId(ledgerId)) {
    return NextResponse.json({ error: 'Expected ?ledgerId=ssp1|ssp2' }, { status: 400 });
  }

  const product: 'cashout' | 'sendmoney' = ledgerId === 'ssp1' ? 'cashout' : 'sendmoney';
  const yesterday = daysAgoStr(1);

  const estimated = await readEstimatedOpeningDisplayPg(product);

  // Wallet-TYPE cards (Bkash/Nagad/Rocket/UPay totals ACROSS all shops) —
  // unrelated to estimated.walletRows below (per-SHOP-per-wallet rows);
  // named walletTypeCards here specifically to avoid confusing the two.
  // computeWalletEstimates is the SAME function the Dashboard's own Opening/
  // wallet tiles call (estimatedWalletCascade.ts) — per explicit instruction,
  // not duplicated here.
  const walletTypeCards = await computeWalletEstimates(ledgerId, product, yesterday, estimated.walletTotals);

  // Unmapped Settlement/Topup — wallet_transactions rows for this upload's
  // cutoffDate whose own `wallet` text didn't normalize to a known wallet
  // type (typos like 'ROCJET'/'NAGA' seen live), captured under 'UNMAPPED'
  // at upload time (see estimatedOpeningService.ts) rather than silently
  // dropped. Surfaced here so totals still reconcile against the true
  // wallet_transactions sum for that date — per explicit instruction, shown
  // as a warning line under the card, not a fabricated 5th wallet row (it
  // has no Opening/DP/WD/Estimated of its own) — and never looked up via
  // WALLET_TO_KEY, so it can never become any wallet's Opening (see that
  // map's own comment in estimatedWalletCascade.ts).
  const unmappedTotals: EstimatedOpeningWalletTotals | undefined = estimated.walletTotals.get('UNMAPPED');
  const unmapped = unmappedTotals && ((unmappedTotals.settlement ?? 0) !== 0 || (unmappedTotals.topUp ?? 0) !== 0)
    ? { settlement: unmappedTotals.settlement ?? 0, topup: unmappedTotals.topUp ?? 0 }
    : null;

  return NextResponse.json({
    walletRows: walletTypeCards,
    unmapped,
    // "Per Shop" — one row per Opening shop, per spec. Its own figures are
    // the sum of estimated.walletRows under the hood (see
    // readEstimatedOpeningDisplayPg's own comment) — that per-wallet
    // breakdown isn't surfaced as its own UI table anymore (removed per
    // explicit follow-up instruction), but still backs this row's
    // reconciliation guarantee.
    shopRows: estimated.shopRows,
    uploadedAt: estimated.uploadedAt ? estimated.uploadedAt.toISOString() : null,
    fileName: estimated.lastImport?.fileName ?? null,
    rowCount: estimated.lastImport?.shopCount ?? null,
  });
}
