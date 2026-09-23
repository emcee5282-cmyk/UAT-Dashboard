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
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { extractOpeningWalletTypeSuffix } from '../realShopName';

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
  // Per-wallet Opening Balance breakdown (opening_wallet_lines — one row
  // per FILE ROW that carried a wallet suffix, e.g. "-BK"/"-NG"), each
  // genuinely a separate entry, never merged. openingBal above stays the
  // shop-level SUM (needed for Company Balance elsewhere). rawAgentName is
  // the file's own literal cell text for that specific row (whitespace-
  // cleaned only, never brand/suffix-stripped) — per explicit instruction,
  // the page displays THIS, not the normalized agentCode, for any shop
  // that has one. walletTypeSuffix (BK/NG/RK/UP) is derived from that same
  // raw text, purely for the page's own Wallet Type column.
  walletOpening: { id: number; rawAgentName: string; amount: number; sdp: number; walletTypeSuffix: string | null }[];
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
    .where(and(eq(schema.agents.product, 'cashout'), eq(schema.agents.isActive, true)));

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
    if (w.isLoggedIn && w.walletTypeCode) {
      if (!walletTypesByAgentId.has(w.agentId)) walletTypesByAgentId.set(w.agentId, new Set());
      walletTypesByAgentId.get(w.agentId)!.add(w.walletTypeCode);
    }
  }

  const agentIds = agentRows.map((a) => a.id);
  const openingLineRows = agentIds.length > 0
    ? await db
        .select({ id: schema.openingWalletLines.id, agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName, openingBalance: schema.openingWalletLines.openingBalance, sdp: schema.openingWalletLines.sdp })
        .from(schema.openingWalletLines)
        .where(inArray(schema.openingWalletLines.agentId, agentIds))
    : [];
  const walletOpeningByAgentId = new Map<number, { id: number; rawAgentName: string; amount: number; sdp: number; walletTypeSuffix: string | null }[]>();
  for (const line of openingLineRows) {
    if (!walletOpeningByAgentId.has(line.agentId)) walletOpeningByAgentId.set(line.agentId, []);
    walletOpeningByAgentId.get(line.agentId)!.push({
      id: line.id,
      rawAgentName: line.rawAgentName,
      amount: parseFloat(line.openingBalance),
      sdp: parseFloat(line.sdp),
      walletTypeSuffix: extractOpeningWalletTypeSuffix(line.rawAgentName),
    });
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
    walletOpening: walletOpeningByAgentId.get(a.id) ?? [],
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
    .where(and(eq(schema.agents.product, 'sendmoney'), eq(schema.agents.isActive, true)));

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
