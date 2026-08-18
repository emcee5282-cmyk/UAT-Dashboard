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
import { eq, and, gte, desc } from 'drizzle-orm';
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
} from '../balanceEngine';
import { getBusinessToday, toBusinessDate } from '../businessDate';
import { readEstimatedOpeningPg } from '../db/read/estimatedOpening';

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
    .where(eq(schema.agents.product, product));

  const walletRows = await db
    .select({
      agentId: schema.agentWallets.agentId,
      balance: schema.agentWallets.balance,
      totalDp: schema.agentWallets.totalDp,
      totalWd: schema.agentWallets.totalWd,
      isLoggedIn: schema.agentWallets.isLoggedIn,
      accountStatus: schema.agentWallets.accountStatus,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .where(eq(schema.agents.product, product));

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
    const walletStatus = wallets.length === 0
      ? 'No Record'
      : computeWalletStatus(wallets.map((w) => (w.isLoggedIn ? (w.accountStatus ?? '') : 'Disconnected')));

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
    };
  });
}

export async function getAgentBalance(product: Product, agentCode: string): Promise<AgentBalanceRow | null> {
  const all = await getAgentBalances(product);
  return all.find((a) => a.agentCode.toLowerCase() === agentCode.toLowerCase()) ?? null;
}
