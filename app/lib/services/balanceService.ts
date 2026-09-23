// Server-side Balance calculation service — LOCAL/FOUNDATION ONLY, not
// wired into any existing page or route.
//
// Every formula here is imported UNCHANGED from app/lib/balanceEngine.ts
// (already a pure, framework-agnostic module with zero Sheets/browser
// dependency — confirmed during the audit). This file only supplies that
// module's inputs from PostgreSQL instead of parsed Sheets/CSV text. Not
// one line of the actual math is reimplemented or "cleaned up" — per
// explicit instruction, including the intentional-looking-odd Available
// Limit formula (today's Total DP subtracted on top of an already-Total-DP
// -inclusive Company Balance).
import { eq, and, gte, desc, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import {
  computeCompanyBalance,
  computeAgentWithdrawal,
  computeBaseLimit,
  computeFrozenAmount,
  computeAvailableLimit,
  computeSdpVsBalance,
  computeWalletStatus,
  computeSendMoneyWalletStatus,
} from '../balanceEngine';
import { getBusinessToday, toBusinessDate, manilaFields } from '../businessDate';
import { readEstimatedOpeningPg } from '../db/read/estimatedOpening';
import { extractOpeningWalletTypeSuffix } from '../realShopName';

export type Product = 'cashout' | 'sendmoney';

// Verbatim from CLAUDE.md's documented Cashout list — NOT read from
// leaders.excluded_from_sdp, because that column exists in the schema but
// was never confirmed populated by any sync/migration step (see the
// column's own comment: "worth confirming with the business, not a
// neutral refactor"). Using the DB column here would risk silently
// changing real behavior without that confirmation ever having happened.
// Send Money is not known to use this same exclusion list — passed empty
// for that product, matching what's actually confirmed, not assumed.
const CASHOUT_EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE', 'MUNIM', 'NIHJUM',
  'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN', 'ROSE', 'SAM', 'XYZ', 'SHAKIL',
  'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR',
];

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

function dateOnlyStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Cutoff signal for the Estimated Opening override + the Top Up/Settlement
// date-window widening below — sourced from import_batches' own live
// completedAt (the daily Bulk Import Opening wizard already logs this on
// every real run), NOT readRosterCutoffPg's roster_sync_log table.
// roster_sync_log is only ever written by scripts/migrate-data.ts's
// standalone historical migration — confirmed via direct query to hold just
// 4 rows total, never updated by any live route — so it can't answer "has
// today's Opening import already landed" for this Postgres-only path.
// Deliberately a NEW function, not a change to readRosterCutoffPg itself:
// that one is shared by two other, already-live consumers
// (estimatedOpeningService.ts's real upload route, estimatedOpening.ts's
// display read) this fix must not affect.
async function readLatestOpeningImportCutoff(db: ReturnType<typeof getDb>, product: Product): Promise<Date | null> {
  const [row] = await db
    .select({ completedAt: schema.importBatches.completedAt })
    .from(schema.importBatches)
    .where(and(
      eq(schema.importBatches.product, product),
      eq(schema.importBatches.importType, 'opening'),
      eq(schema.importBatches.status, 'completed')
    ))
    .orderBy(desc(schema.importBatches.completedAt))
    .limit(1);
  return row?.completedAt ?? null;
}

// db-less wrapper for external callers (e.g. app/api/dashboard/route.ts's
// findReportCutoffDate replacement) — same semantic meaning ("when was
// Opening last refreshed for this product") as the old "Opening AG" sheet's
// own "REPORT LAST UPDATE"/"UPDATED TIME" card, just read from Postgres.
export async function getLatestOpeningImportCutoff(product: Product): Promise<Date | null> {
  return readLatestOpeningImportCutoff(getDb(), product);
}

function isoDateOf(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "Today" for Settlement/Top Up/CashGo's date-range filter is NOT the raw
// 2 AM Manila wall-clock rollover (getBusinessToday()) — ops works one
// business day at a time. Per explicit instruction: whichever of these two
// real upload signals is CLOSER to the actual current date wins —
// - the latest real Opening import's own completedAt
//   (readLatestOpeningImportCutoff — the same signal the Balance page's
//   own "today's window" cutoff already trusts), and
// - the latest Estimated Opening upload's own uploadedAt
// — each resolved to its own Manila business date, taking the later
// (more-recent) of the two, capped at (never later than) raw wall-clock
// today. A fresh Opening re-upload with no matching Estimated Opening yet
// still correctly advances "Today" — Estimated Opening is not a hard gate,
// just one of two signals.
export async function getEffectiveBusinessToday(product: Product): Promise<string> {
  const db = getDb();
  const { year, month, day } = manilaFields(getBusinessToday());
  const rawToday = isoDateOf(year, month, day);

  const [openingCutoff, estimated] = await Promise.all([
    readLatestOpeningImportCutoff(db, product),
    readEstimatedOpeningPg(product),
  ]);

  const candidates: string[] = [];
  if (openingCutoff) {
    const f = manilaFields(toBusinessDate(openingCutoff));
    candidates.push(isoDateOf(f.year, f.month, f.day));
  }
  if (estimated.uploadedAt) {
    const f = manilaFields(toBusinessDate(estimated.uploadedAt));
    candidates.push(isoDateOf(f.year, f.month, f.day));
  }
  if (candidates.length === 0) return rawToday;

  const latest = candidates.reduce((a, b) => (b > a ? b : a));
  return latest < rawToday ? latest : rawToday;
}

// Cutoff signal for the Estimated Opening override + Top Up/Settlement
// date-window widening — computed once here and reused by both
// getAgentBalances() and getTopUpSettlementTotals() below, so the two never
// drift out of sync on what "today's window" actually means for a product.
async function computeTopUpSettlementCutoff(db: ReturnType<typeof getDb>, product: Product, businessToday: Date): Promise<{ cutoff: Date; estimatedOpeningValid: boolean; estimated: Awaited<ReturnType<typeof readEstimatedOpeningPg>> }> {
  const [estimated, lastKnownCutoff] = await Promise.all([
    readEstimatedOpeningPg(product),
    readLatestOpeningImportCutoff(db, product),
  ]);
  const estimatedOpeningValid =
    lastKnownCutoff !== null &&
    lastKnownCutoff.getTime() < businessToday.getTime() &&
    estimated.uploadedAt !== null &&
    toBusinessDate(estimated.uploadedAt).getTime() === businessToday.getTime();

  // Normally "today" only, same as every Sheets-based page. Widens to the
  // last known Opening import's own date ONLY when that import is stale
  // (hasn't landed for today yet) AND no valid Estimated Balance already
  // covers today — mirrors app/agentbal's and app/sendmoney/balances'
  // topUpSettlementCutoff exactly, so a day's Top Up/Settlement doesn't
  // disappear across the 2AM business-day rollover while the roster is
  // still catching up. Once a valid Estimated Balance exists it already
  // bakes that stale day in, so this goes back to today-only to avoid
  // double-counting.
  const cutoff = (lastKnownCutoff !== null && lastKnownCutoff.getTime() < businessToday.getTime() && !estimatedOpeningValid)
    ? lastKnownCutoff
    : businessToday;

  return { cutoff, estimatedOpeningValid, estimated };
}

export type TopUpSettlementTotals = { totalTopUp: number; totalSettlement: number };

// Shared by getAgentBalances() below and the standalone Settlement/Top Up
// migration (app/api/v2/stlmtopup) — single source of truth for this figure,
// same reasoning app/lib/transferQueueRules.ts's own header comment gives
// for not letting per-page copies of a calculation drift apart. Keyed by
// agentCode (not agentId) since every caller ultimately needs to match
// against a roster's own shop-name column, not an internal id.
export async function getTopUpSettlementTotals(product: Product): Promise<Map<string, TopUpSettlementTotals>> {
  const db = getDb();
  const businessToday = getBusinessToday();
  const { cutoff } = await computeTopUpSettlementCutoff(db, product, businessToday);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const codeByAgentId = new Map(agentRows.map((a) => [a.id, a.agentCode]));

  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
    })
    .from(schema.walletTransactions)
    .where(and(
      eq(schema.walletTransactions.product, product),
      gte(schema.walletTransactions.occurredOn, dateOnlyStr(cutoff))
    ));

  const totalsByCode = new Map<string, TopUpSettlementTotals>();
  for (const t of txRows) {
    const agentCode = codeByAgentId.get(t.agentId);
    if (!agentCode) continue;
    const bucket = totalsByCode.get(agentCode) ?? { totalTopUp: 0, totalSettlement: 0 };
    if (t.transactionType === 'topup') bucket.totalTopUp += n(t.amount);
    else bucket.totalSettlement += n(t.amount);
    totalsByCode.set(agentCode, bucket);
  }
  return totalsByCode;
}

export type AgentBalanceRow = {
  agentId: number;
  agentCode: string;
  leader: string;
  brand: string;
  sdp: number;
  openingBalance: number;
  totalDp: number;
  totalWd: number;
  totalTopUp: number;
  totalSettlement: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  baseLimit: number;
  frozenAmount: number;
  availableLimit: number;
  sdpVsBalance: number;
  walletStatus: string;
  walletType: string[];
};

export async function getAgentBalances(product: Product): Promise<AgentBalanceRow[]> {
  const db = getDb();
  const businessToday = getBusinessToday(); // Date, Manila-midnight — see businessDate.ts, reused unchanged

  const agentRows = await db
    .select({
      id: schema.agents.id,
      agentCode: schema.agents.agentCode,
      sdp: schema.agents.sdp,
      openingBalance: schema.agents.openingBalance,
      leaderName: schema.leaders.name,
      brandCode: schema.brands.code,
    })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(schema.brands, eq(schema.agents.brandId, schema.brands.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const walletRows = await db
    .select({
      agentId: schema.agentWallets.agentId,
      balance: schema.agentWallets.balance,
      totalDp: schema.agentWallets.totalDp,
      totalWd: schema.agentWallets.totalWd,
      isLoggedIn: schema.agentWallets.isLoggedIn,
      accountStatus: schema.agentWallets.accountStatus,
      walletTypeCode: schema.walletTypes.code,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const walletsByAgent = new Map<number, typeof walletRows>();
  for (const w of walletRows) {
    if (!walletsByAgent.has(w.agentId)) walletsByAgent.set(w.agentId, []);
    walletsByAgent.get(w.agentId)!.push(w);
  }

  const excludedSdpLeaders = product === 'cashout' ? CASHOUT_EXCLUDED_SDP_LEADERS : [];

  // Estimated Opening override + Top Up/Settlement date-window widening —
  // matches app/agentbal/page.tsx's and app/sendmoney/balances/page.tsx's
  // own Sheets-mode dual-condition rule exactly. Factored out into
  // computeTopUpSettlementCutoff() (above) so this and the standalone
  // getTopUpSettlementTotals() (also above, backing app/api/v2/stlmtopup)
  // share one implementation instead of two copies drifting apart.
  const { cutoff: topUpSettlementCutoff, estimatedOpeningValid, estimated } = await computeTopUpSettlementCutoff(db, product, businessToday);

  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
    })
    .from(schema.walletTransactions)
    .where(and(
      eq(schema.walletTransactions.product, product),
      gte(schema.walletTransactions.occurredOn, dateOnlyStr(topUpSettlementCutoff))
    ));

  const txByAgent = new Map<number, { topUp: number; settlement: number }>();
  for (const t of txRows) {
    const bucket = txByAgent.get(t.agentId) ?? { topUp: 0, settlement: 0 };
    if (t.transactionType === 'topup') bucket.topUp += n(t.amount);
    else bucket.settlement += n(t.amount);
    txByAgent.set(t.agentId, bucket);
  }

  return agentRows.map((agent) => {
    const wallets = walletsByAgent.get(agent.id) ?? [];
    const totalDp = wallets.reduce((sum, w) => sum + n(w.totalDp), 0);
    const totalWd = wallets.reduce((sum, w) => sum + n(w.totalWd), 0);
    // agent_wallets.is_logged_in is already a clean boolean (parsed once
    // at sync time via isLoggedIn() against the raw "Login" cell) — no
    // need to round-trip it back through that same string-based helper.
    const balanceInside = wallets.reduce((sum, w) => sum + (w.isLoggedIn ? n(w.balance) : 0), 0);
    const tx = txByAgent.get(agent.id) ?? { topUp: 0, settlement: 0 };
    const rawOpening = n(agent.openingBalance);
    const assumedBalance = estimatedOpeningValid ? estimated.balances.get(agent.agentCode) : undefined;
    const opening = assumedBalance ?? rawOpening;
    const sdp = n(agent.sdp);

    const companyBalance = computeCompanyBalance(opening, totalDp, tx.topUp, totalWd, tx.settlement);
    const agentWithdrawal = computeAgentWithdrawal(companyBalance, balanceInside);
    const baseLimit = computeBaseLimit(sdp);
    const frozenAmount = computeFrozenAmount(companyBalance, baseLimit);
    const availableLimit = computeAvailableLimit(baseLimit, companyBalance, totalDp);
    const sdpVsBalance = computeSdpVsBalance(agent.leaderName ?? '', agent.sdp ?? '', sdp, companyBalance, excludedSdpLeaders);
    // "No Record" matches the live pages' own rule exactly: an agent absent
    // from the Balance Limit sheet entirely (zero wallet rows here) shows
    // "No Record", never falling through to computeWalletStatus([])'s own
    // "Disconnected" default, which is reserved for an agent that DOES have
    // wallet rows but none with a recognized status.
    //
    // Login override: a wallet that isn't logged in reads as Disconnected
    // regardless of what its Group would otherwise resolve to — the same
    // rule already live on all 4 Sheets-mode pages (app/agentbal,
    // app/sendmoney/balances, app/wallet-status, app/sendmoney/wallet-status).
    // Missing here until now — confirmed via a real field-by-field diff
    // against Sheets-mode output: 91%/77% (Cashout/Send Money) of this
    // function's walletStatus mismatches were exactly this pattern
    // (Sheets-mode correctly showing Disconnected, this function showing the
    // raw un-overridden status), not data staleness.
    // Send Money's own "Daily/Monthly Reach Limit" Group values must display
    // verbatim, not collapse into Disconnected — Cashout never produces
    // these, so it keeps calling the plain computeWalletStatus unchanged.
    const rollupStatus = product === 'sendmoney' ? computeSendMoneyWalletStatus : computeWalletStatus;
    const walletStatus = wallets.length === 0
      ? 'No Record'
      : rollupStatus(wallets.map((w) => (w.isLoggedIn ? (w.accountStatus ?? '') : 'Disconnected')));
    // Raw wallet-type codes ('BKASH'/'NAGAD'/'ROCKET'/'UPAY'), deduped,
    // logged-in wallets only — same condition the Sheets-mode pages apply
    // (a disconnected wallet's type doesn't count toward the shop's
    // displayed Wallet Type). Callers already have their own
    // computeWalletType()-equivalent formatter (abbreviate + join) — this
    // returns the raw set so that single existing formatter stays the only
    // place that logic lives, instead of a second copy here.
    const walletType = Array.from(new Set(
      wallets.filter((w) => w.isLoggedIn && w.walletTypeCode).map((w) => w.walletTypeCode as string)
    ));

    return {
      agentId: agent.id,
      agentCode: agent.agentCode,
      leader: agent.leaderName ?? '',
      brand: agent.brandCode ?? '−',
      sdp,
      openingBalance: opening,
      totalDp,
      totalWd,
      totalTopUp: tx.topUp,
      totalSettlement: tx.settlement,
      companyBalance,
      balanceInside,
      agentWithdrawal,
      baseLimit,
      frozenAmount,
      availableLimit,
      sdpVsBalance,
      walletStatus,
      walletType,
    };
  });
}

export async function getAgentBalance(product: Product, agentCode: string): Promise<AgentBalanceRow | null> {
  const all = await getAgentBalances(product);
  return all.find((a) => a.agentCode.toLowerCase() === agentCode.toLowerCase()) ?? null;
}

// opening_wallet_lines' own walletTypeSuffix (BK/NG/RK/UP, extracted from
// the Opening file's raw per-wallet row text) vs agent_wallets/
// wallet_transactions' full wallet-type name (BKASH/NAGAD/ROCKET/UPAY,
// confirmed via importService.ts's WALLET_OPTIONS and
// app/agentbal/page.tsx's own WALLET_TYPE_ORDER) — same abbreviation
// mapping the Balance page's client-side computeWalletType() already uses,
// duplicated here since this is the one place server-side that needs to go
// the OTHER direction (abbreviation -> full name) to match a line to its
// real wallet.
const OPENING_SUFFIX_TO_WALLET_TYPE: Record<string, string> = {
  BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY',
};
// The other direction — needed to reconstruct a synthesized raw display
// name (see the "orphan wallet" handling below) for a real wallet that has
// no opening_wallet_lines row of its own to source one from.
const WALLET_TYPE_TO_OPENING_SUFFIX: Record<string, string> = {
  BKASH: 'BK', NAGAD: 'NG', ROCKET: 'RK', UPAY: 'UP',
};

type WalletRowForCalc = {
  balance: string | null;
  totalDp: string | null;
  totalWd: string | null;
  isLoggedIn: boolean;
  accountStatus: string | null;
  walletTypeCode: string | null;
};

// The actual per-shop (or per-wallet, when called for one split row) math —
// factored out of getAgentBalances' own inline body so
// getAgentBalancesForBalancePage below can run the exact same formulas
// against a narrower slice (one wallet's own agent_wallets row(s) + its own
// Top Up/Settlement) instead of the whole shop, without a second,
// drifting copy of this logic.
function computeBalanceFields(params: {
  opening: number;
  sdp: number;
  sdpRawText: string;
  leaderName: string;
  wallets: WalletRowForCalc[];
  tx: { topUp: number; settlement: number };
  excludedSdpLeaders: string[];
  product: Product;
}) {
  const { opening, sdp, sdpRawText, leaderName, wallets, tx, excludedSdpLeaders, product } = params;
  const totalDp = wallets.reduce((sum, w) => sum + n(w.totalDp), 0);
  const totalWd = wallets.reduce((sum, w) => sum + n(w.totalWd), 0);
  const balanceInside = wallets.reduce((sum, w) => sum + (w.isLoggedIn ? n(w.balance) : 0), 0);

  const companyBalance = computeCompanyBalance(opening, totalDp, tx.topUp, totalWd, tx.settlement);
  const agentWithdrawal = computeAgentWithdrawal(companyBalance, balanceInside);
  const baseLimit = computeBaseLimit(sdp);
  const frozenAmount = computeFrozenAmount(companyBalance, baseLimit);
  const availableLimit = computeAvailableLimit(baseLimit, companyBalance, totalDp);
  const sdpVsBalance = computeSdpVsBalance(leaderName, sdpRawText, sdp, companyBalance, excludedSdpLeaders);

  const rollupStatus = product === 'sendmoney' ? computeSendMoneyWalletStatus : computeWalletStatus;
  const walletStatus = wallets.length === 0
    ? 'No Record'
    : rollupStatus(wallets.map((w) => (w.isLoggedIn ? (w.accountStatus ?? '') : 'Disconnected')));
  const walletType = Array.from(new Set(
    wallets.filter((w) => w.isLoggedIn && w.walletTypeCode).map((w) => w.walletTypeCode as string)
  ));

  return { totalDp, totalWd, totalTopUp: tx.topUp, totalSettlement: tx.settlement, balanceInside, companyBalance, agentWithdrawal, baseLimit, frozenAmount, availableLimit, sdpVsBalance, walletStatus, walletType };
}

// A Balance-page-only row: identical to AgentBalanceRow, plus displayName
// (the Opening file's own raw per-wallet text for a split row, else just
// agentCode) and lineId (the opening_wallet_lines id backing a split row,
// null otherwise — not wired to any edit action yet, kept for parity with
// Opening's own row identity in case that's needed later).
export type AgentBalanceSplitRow = AgentBalanceRow & {
  displayName: string;
  lineId: number | null;
};

// Balance page (app/agentbal, Cashout only — Send Money has no
// opening_wallet_lines data, see importService.ts) — per explicit
// instruction, a shop Opening already displays as multiple per-wallet rows
// (opening_wallet_lines.length >= 2) must ALSO show as multiple rows here,
// each showing ONLY that one wallet's own Opening/SDP/Total DP/Total WD/
// Top Up/Settlement/Company Balance/etc — never the whole-shop combined
// figures repeated across rows. A shop with 0 or 1 lines renders exactly as
// getAgentBalances() already produces it (single row, shop-level
// aggregate), completely unchanged — this function must never combine
// shops that were already separate in Opening, but must also never split a
// shop Opening itself doesn't split.
export async function getAgentBalancesForBalancePage(product: Product): Promise<AgentBalanceSplitRow[]> {
  const db = getDb();
  const businessToday = getBusinessToday();

  const agentRows = await db
    .select({
      id: schema.agents.id,
      agentCode: schema.agents.agentCode,
      sdp: schema.agents.sdp,
      openingBalance: schema.agents.openingBalance,
      leaderName: schema.leaders.name,
      brandCode: schema.brands.code,
    })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(schema.brands, eq(schema.agents.brandId, schema.brands.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const walletRows = await db
    .select({
      agentId: schema.agentWallets.agentId,
      balance: schema.agentWallets.balance,
      totalDp: schema.agentWallets.totalDp,
      totalWd: schema.agentWallets.totalWd,
      isLoggedIn: schema.agentWallets.isLoggedIn,
      accountStatus: schema.agentWallets.accountStatus,
      walletTypeCode: schema.walletTypes.code,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const walletsByAgent = new Map<number, typeof walletRows>();
  for (const w of walletRows) {
    if (!walletsByAgent.has(w.agentId)) walletsByAgent.set(w.agentId, []);
    walletsByAgent.get(w.agentId)!.push(w);
  }

  const excludedSdpLeaders = product === 'cashout' ? CASHOUT_EXCLUDED_SDP_LEADERS : [];

  const { cutoff: topUpSettlementCutoff, estimatedOpeningValid, estimated } = await computeTopUpSettlementCutoff(db, product, businessToday);

  // wallet field added (unlike getAgentBalances' own txRows query) — needed
  // to attribute a Top Up/Settlement row to the ONE wallet it actually
  // belongs to when a shop is split, not just the whole agent.
  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
    })
    .from(schema.walletTransactions)
    .where(and(
      eq(schema.walletTransactions.product, product),
      gte(schema.walletTransactions.occurredOn, dateOnlyStr(topUpSettlementCutoff))
    ));

  const txByAgent = new Map<number, { topUp: number; settlement: number }>();
  // Keyed `${agentId}:${wallet}` — only meaningfully populated for products
  // that actually have opening_wallet_lines (cashout today); sendmoney rows
  // never hit this map's lookup since sendmoney agents never get >=2 lines.
  const txByAgentWallet = new Map<string, { topUp: number; settlement: number }>();
  for (const t of txRows) {
    const bucket = txByAgent.get(t.agentId) ?? { topUp: 0, settlement: 0 };
    if (t.transactionType === 'topup') bucket.topUp += n(t.amount); else bucket.settlement += n(t.amount);
    txByAgent.set(t.agentId, bucket);

    if (t.wallet) {
      const key = `${t.agentId}:${t.wallet}`;
      const walletBucket = txByAgentWallet.get(key) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') walletBucket.topUp += n(t.amount); else walletBucket.settlement += n(t.amount);
      txByAgentWallet.set(key, walletBucket);
    }
  }

  const agentIds = agentRows.map((a) => a.id);
  const lineRows = agentIds.length > 0
    ? await db
        .select({
          id: schema.openingWalletLines.id,
          agentId: schema.openingWalletLines.agentId,
          rawAgentName: schema.openingWalletLines.rawAgentName,
          openingBalance: schema.openingWalletLines.openingBalance,
          sdp: schema.openingWalletLines.sdp,
        })
        .from(schema.openingWalletLines)
        .where(inArray(schema.openingWalletLines.agentId, agentIds))
    : [];
  const linesByAgent = new Map<number, typeof lineRows>();
  for (const l of lineRows) {
    if (!linesByAgent.has(l.agentId)) linesByAgent.set(l.agentId, []);
    linesByAgent.get(l.agentId)!.push(l);
  }

  const results: AgentBalanceSplitRow[] = [];

  for (const agent of agentRows) {
    const wallets = walletsByAgent.get(agent.id) ?? [];
    const lines = linesByAgent.get(agent.id) ?? [];
    const leaderName = agent.leaderName ?? '';
    const brand = agent.brandCode ?? '−';

    if (lines.length === 0) {
      // Unchanged shape — same single shop-level row getAgentBalances()
      // itself would produce for this agent (Opening never split this shop,
      // so Balance must not invent a split either). Threshold matches
      // Opening's own `walletOpening.length > 0` exactly (app/summary/
      // page.tsx) — a shop with even ONE captured per-wallet line (e.g.
      // "N-M1AG-S9-ABYSSAL006-BK", its only wallet) still uses that line's
      // own raw name below, never the bare code. Originally gated on
      // `< 2`, which silently kept every single-line shop on the bare-code
      // branch — confirmed live as the cause of Balance still showing
      // "ABYSSAL006" instead of the raw name Opening already displays.
      const tx = txByAgent.get(agent.id) ?? { topUp: 0, settlement: 0 };
      const rawOpening = n(agent.openingBalance);
      const assumedBalance = estimatedOpeningValid ? estimated.balances.get(agent.agentCode) : undefined;
      const opening = assumedBalance ?? rawOpening;
      const sdp = n(agent.sdp);
      const fields = computeBalanceFields({ opening, sdp, sdpRawText: agent.sdp ?? '', leaderName, wallets, tx, excludedSdpLeaders, product });

      results.push({
        agentId: agent.id,
        agentCode: agent.agentCode,
        displayName: agent.agentCode,
        lineId: null,
        leader: leaderName,
        brand,
        sdp,
        openingBalance: opening,
        ...fields,
      });
      continue;
    }

    // Opening already shows this shop as N separate per-wallet rows — mirror
    // that exactly, one Balance row per line, each computed from ONLY that
    // wallet's own real data (not the shop-wide aggregate repeated).
    for (const line of lines) {
      const walletTypeSuffix = extractOpeningWalletTypeSuffix(line.rawAgentName);
      const walletTypeFull = walletTypeSuffix ? OPENING_SUFFIX_TO_WALLET_TYPE[walletTypeSuffix] : null;
      const lineWallets = walletTypeFull ? wallets.filter((w) => w.walletTypeCode === walletTypeFull) : [];
      const lineTx = walletTypeFull ? (txByAgentWallet.get(`${agent.id}:${walletTypeFull}`) ?? { topUp: 0, settlement: 0 }) : { topUp: 0, settlement: 0 };
      // Same Estimated Opening override as the lines.length === 0 branch
      // above, just applied per LINE instead of per shop — a shop Opening
      // splits into wallets needs each wallet's own Estimated figure, not
      // the shop-wide one repeated across every row (there is no single
      // shop-wide figure that would even be correct here). This branch
      // previously never checked estimatedOpeningValid at all, so ANY
      // split shop's Opening always fell back to the raw opening_wallet_lines
      // value even on a day Opening had no fresh upload but Estimated
      // Balance did — confirmed live as why Balance's Opening column
      // stopped matching Estimated Balance once most shops started
      // splitting into per-wallet lines.
      const rawLineOpening = n(line.openingBalance);
      const lineAssumed = estimatedOpeningValid && walletTypeFull ? estimated.walletLineBalances.get(`${agent.id}:${walletTypeFull}`) : undefined;
      const opening = lineAssumed ?? rawLineOpening;
      const sdp = n(line.sdp);
      const fields = computeBalanceFields({ opening, sdp, sdpRawText: String(sdp), leaderName, wallets: lineWallets, tx: lineTx, excludedSdpLeaders, product });

      results.push({
        agentId: agent.id,
        agentCode: agent.agentCode,
        displayName: line.rawAgentName,
        lineId: line.id,
        leader: leaderName,
        brand,
        sdp,
        openingBalance: opening,
        ...fields,
      });
    }

    // General rule (not a DRUID004 special case) — a shop can have a real
    // agent_wallets row (real DP/WD from Balance Limit) for a wallet type
    // NONE of its opening_wallet_lines cover, e.g. Opening only ever had
    // this shop's "-BK" row but Balance Limit also shows real "-NG"
    // activity. The loop above only ever emits one row per LINE, so that
    // wallet's real money was silently disappearing — neither folded into
    // the "-BK" row above (excluded by its own walletType filter) nor
    // getting a row of its own. Confirmed live: DRUID004's NAGAD wallet
    // (₱2,600 DP) had no opening_wallet_line and never appeared anywhere.
    // Fixed by giving every such orphan wallet its own row too, reusing
    // any sibling line's own raw name as a template (every wallet's raw
    // text for the same shop shares the same prefix, differing only in the
    // trailing 2-letter suffix) — lineId stays null since there's no real
    // opening_wallet_lines row backing it (Opening genuinely has no
    // Opening Balance/SDP for this wallet, both correctly 0 here).
    const coveredWalletTypes = new Set(
      lines
        .map((l) => extractOpeningWalletTypeSuffix(l.rawAgentName))
        .filter((s): s is string => s !== null)
        .map((s) => OPENING_SUFFIX_TO_WALLET_TYPE[s])
    );
    const orphanWalletTypes = new Set(
      wallets
        .map((w) => w.walletTypeCode)
        .filter((code): code is string => code !== null && !coveredWalletTypes.has(code))
    );
    if (orphanWalletTypes.size > 0) {
      const templateRawName = lines[0].rawAgentName;
      for (const walletTypeFull of orphanWalletTypes) {
        const suffix = WALLET_TYPE_TO_OPENING_SUFFIX[walletTypeFull];
        if (!suffix) continue; // unrecognized wallet type code — nothing to reconstruct a name from, skip rather than guess
        const orphanWallets = wallets.filter((w) => w.walletTypeCode === walletTypeFull);
        const orphanTx = txByAgentWallet.get(`${agent.id}:${walletTypeFull}`) ?? { topUp: 0, settlement: 0 };
        const fields = computeBalanceFields({ opening: 0, sdp: 0, sdpRawText: '0', leaderName, wallets: orphanWallets, tx: orphanTx, excludedSdpLeaders, product });

        results.push({
          agentId: agent.id,
          agentCode: agent.agentCode,
          displayName: templateRawName.replace(/-[A-Za-z]{2}$/, `-${suffix}`),
          lineId: null,
          leader: leaderName,
          brand,
          sdp: 0,
          openingBalance: 0,
          ...fields,
        });
      }
    }
  }

  return results;
}
