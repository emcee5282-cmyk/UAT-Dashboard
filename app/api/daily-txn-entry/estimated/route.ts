import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { readEstimatedOpeningDisplayPg } from '@/app/lib/db/read/estimatedOpening';
import { getLatestDailyTxnWalletClosing } from '@/app/lib/db/read/dailyTxnWalletClosing';

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
//   - Wallet Breakdown Estimated: per-wallet Estimated = latest available
//     Wallet Breakdown Opening amount on/before YESTERDAY (dailyTxnWalletClosingEntry,
//     carried further back via getLatestDailyTxnWalletClosing when even
//     yesterday's entry is missing) + uploaded Total DP − uploaded Total WD
//     (confirmed formula). Deliberately excludes TODAY's own entry as the
//     baseline — same reasoning as Estimated Opening (Each Shop)'s own
//     previousOpeningBalance: a fresh same-day entry must never become its
//     own estimate's baseline, so today's figure can be sanity-checked
//     against what this card already shows instead of silently replacing it.
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

// One business day before today — the Wallet Breakdown Estimated card's own
// baseline cutoff (see this file's header comment). Not reused for
// shopRows/walletRows below: those already carry their own
// previousOpeningBalance baseline from readEstimatedOpeningDisplayPg.
function yesterdayStr(): string {
  const yesterday = new Date(getBusinessToday().getTime() - 24 * 60 * 60 * 1000);
  const { year, month, day } = manilaFields(yesterday);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidLedgerId(v: unknown): v is 'ssp1' | 'ssp2' {
  return v === 'ssp1' || v === 'ssp2';
}

const PG_WALLETS = ['Bkash', 'Nagad', 'Rocket', 'UPay'] as const;
const WALLET_TO_KEY: Record<(typeof PG_WALLETS)[number], string> = {
  Bkash: 'BKASH',
  Nagad: 'NAGAD',
  Rocket: 'ROCKET',
  UPay: 'UPAY',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ledgerId = url.searchParams.get('ledgerId');
  if (!isValidLedgerId(ledgerId)) {
    return NextResponse.json({ error: 'Expected ?ledgerId=ssp1|ssp2' }, { status: 400 });
  }

  const product: 'cashout' | 'sendmoney' = ledgerId === 'ssp1' ? 'cashout' : 'sendmoney';

  const [estimated, openingRows] = await Promise.all([
    readEstimatedOpeningDisplayPg(product),
    getLatestDailyTxnWalletClosing(ledgerId, yesterdayStr()),
  ]);

  const openingByWallet = new Map(openingRows.map((r) => [r.wallet, r.amount]));

  // Wallet-TYPE cards (Bkash/Nagad/Rocket/UPay totals ACROSS all shops) —
  // unrelated to estimated.walletRows below (per-SHOP-per-wallet rows);
  // named walletTypeCards here specifically to avoid confusing the two.
  const walletTypeCards = PG_WALLETS.map((wallet) => {
    const t = estimated.walletTotals.get(WALLET_TO_KEY[wallet]);
    const opening = openingByWallet.get(wallet) ?? null;
    const amount = t ? (opening ?? 0) + t.totalDP - t.totalWD : null;
    return { wallet, amount, totalDp: t?.totalDP ?? null, totalWd: t?.totalWD ?? null, opening };
  });

  return NextResponse.json({
    walletRows: walletTypeCards,
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
