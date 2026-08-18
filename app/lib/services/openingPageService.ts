// Phase 5 — dedicated PostgreSQL reads for the "Today's Opening" pages
// (app/summary/page.tsx for Cashout, app/sendmoney/opening/page.tsx for
// Send Money). Deliberately NOT built on top of balanceService.ts's
// getAgentBalances(): that function's own n() helper collapses a null
// opening/sdp to 0 (correct for ITS OWN Company Balance arithmetic) and
// doesn't currently join wallet_types at all — reusing it here would
// either silently erase Send Money Opening's documented null-vs-zero
// distinction or require extending a shared, already-validated function
// for one page's display-only needs. Two small, purpose-built reads
// instead, matching the same "new function alongside the existing one"
// pattern already used for roster_sync_log and Estimated Opening's
// display contract.
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}
function nOrNull(val: string | null): number | null {
  return val === null ? null : parseFloat(val);
}

export type CashoutOpeningRow = {
  agentCode: string;
  leader: string;
  brand: string;
  // Cashout Opening's own established convention: blank/null coerces to 0
  // (see app/summary/page.tsx's own clean() — this page's data model,
  // deliberately different from Send Money's, preserved exactly here).
  openingBal: number;
  sdp: number;
  // Raw isLoggedIn-gated wallet-type codes (e.g. ['BKASH','NAGAD']) — the
  // page's own existing computeWalletType() turns this into "BK | NG"
  // client-side, unchanged, same as it already does from the Sheets path.
  walletTypes: string[];
  // Opening's daily-upload feature (Phase 3) — isActive backs the page's
  // own muted "Inactive" badge; lastImportMatchedAt backs the Bulk Import
  // wizard's Missing Shops review ("Last updated: ...").
  isActive: boolean;
  lastImportMatchedAt: string | null;
};

export async function getCashoutOpeningRows(): Promise<CashoutOpeningRow[]> {
  const db = getDb();

  const agentRows = await db
    .select({
      id: schema.agents.id,
      agentCode: schema.agents.agentCode,
      leaderName: schema.leaders.name,
      brandCode: schema.brands.code,
      openingBalance: schema.agents.openingBalance,
      sdp: schema.agents.sdp,
      isActive: schema.agents.isActive,
      lastImportMatchedAt: schema.agents.lastImportMatchedAt,
    })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(schema.brands, eq(schema.agents.brandId, schema.brands.id))
    .where(eq(schema.agents.product, 'cashout'));

  const walletRows = await db
    .select({
      agentId: schema.agentWallets.agentId,
      isLoggedIn: schema.agentWallets.isLoggedIn,
      walletTypeCode: schema.walletTypes.code,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(eq(schema.agents.product, 'cashout'));

  const walletTypesByAgentId = new Map<number, Set<string>>();
  for (const w of walletRows) {
    if (!w.isLoggedIn || !w.walletTypeCode) continue;
    if (!walletTypesByAgentId.has(w.agentId)) walletTypesByAgentId.set(w.agentId, new Set());
    walletTypesByAgentId.get(w.agentId)!.add(w.walletTypeCode);
  }

  return agentRows.map((a) => ({
    agentCode: a.agentCode,
    leader: a.leaderName ?? '',
    brand: a.brandCode ?? '−',
    openingBal: n(a.openingBalance),
    sdp: n(a.sdp),
    walletTypes: Array.from(walletTypesByAgentId.get(a.id) ?? []),
    isActive: a.isActive,
    lastImportMatchedAt: a.lastImportMatchedAt ? a.lastImportMatchedAt.toISOString() : null,
  }));
}

export type SendMoneyOpeningPgRow = {
  agentCode: string;
  leader: string;
  brand: string | null;
  // Send Money Opening's own established convention: blank stays null,
  // never coerced to 0 (see app/lib/sendMoneyOpening.ts's own comment —
  // "a blank cell means 'not set', must stay null so sums/counts can tell
  // the difference from a genuine zero balance"). Preserved exactly.
  openingBalance: number | null;
  securityDeposit: number | null;
  // Opening's daily-upload feature (Phase 3) — same as CashoutOpeningRow.
  isActive: boolean;
  lastImportMatchedAt: string | null;
};

export async function getSendMoneyOpeningPgRows(): Promise<SendMoneyOpeningPgRow[]> {
  const db = getDb();

  const agentRows = await db
    .select({
      agentCode: schema.agents.agentCode,
      leaderName: schema.leaders.name,
      brandCode: schema.brands.code,
      openingBalance: schema.agents.openingBalance,
      sdp: schema.agents.sdp,
      isActive: schema.agents.isActive,
      lastImportMatchedAt: schema.agents.lastImportMatchedAt,
    })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(schema.brands, eq(schema.agents.brandId, schema.brands.id))
    .where(eq(schema.agents.product, 'sendmoney'));

  return agentRows.map((a) => ({
    agentCode: a.agentCode,
    leader: a.leaderName ?? '',
    brand: a.brandCode ?? null,
    openingBalance: nOrNull(a.openingBalance),
    securityDeposit: nOrNull(a.sdp),
    isActive: a.isActive,
    lastImportMatchedAt: a.lastImportMatchedAt ? a.lastImportMatchedAt.toISOString() : null,
  }));
}
