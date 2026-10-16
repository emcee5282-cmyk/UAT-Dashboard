// Pending Balance > Stagnant Balances — reads the streak
// importEstimatedOpeningFromUpload() (estimatedOpeningService.ts) maintains
// on every Estimated Balance upload. Only agents that have ACTUALLY crossed
// the 3-day "stagnant" threshold are returned — a shop at 0/1/2 days isn't
// stagnant yet and shouldn't appear anywhere on this page, not even as a
// zero-count row under its own leader.
import { eq, and, gte, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getAgentBalances } from './balanceService';

export type Product = 'cashout' | 'sendmoney';

export const STAGNANT_THRESHOLD_DAYS = 3;

const EXCLUDED_LEADER_NAMES = new Set(['NEW SHOP', 'NEW-TEMPAUTOPLOT']);

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

export type StagnantBalanceRow = {
  line: Product;
  leader: string;
  shopName: string;
  companyBalance: number;
  balanceInside: number;
  sdp: number;
  noDataStreakDays: number;
};

async function getStreakRowsForProduct(product: Product, options?: { force?: boolean }): Promise<StagnantBalanceRow[]> {
  const db = getDb();

  const [streakRows, balanceRows] = await Promise.all([
    db
      .select({
        agentCode: schema.agents.agentCode,
        sdp: schema.agents.sdp,
        leaderName: schema.leaders.name,
        noDataStreakDays: schema.stagnantBalanceTracking.noDataStreakDays,
      })
      .from(schema.stagnantBalanceTracking)
      .innerJoin(schema.agents, eq(schema.stagnantBalanceTracking.agentId, schema.agents.id))
      .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
      .where(and(
        eq(schema.agents.product, product),
        eq(schema.agents.isActive, true),
        gte(schema.stagnantBalanceTracking.noDataStreakDays, STAGNANT_THRESHOLD_DAYS)
      )),
    // Same live Company Balance/Balance Inside source as Discrepancy
    // Summary/Unreconciled Balance (balanceEngine.ts's formulas via
    // balanceService.ts) — not re-derived here, so this page's figures
    // never drift from those other tabs'.
    getAgentBalances(product, options),
  ]);

  const balanceByCode = new Map(balanceRows.map((b) => [b.agentCode, b]));

  const out: StagnantBalanceRow[] = [];
  for (const r of streakRows) {
    const leader = (r.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const balance = balanceByCode.get(r.agentCode);
    const companyBalance = balance?.companyBalance ?? 0;
    // Positive Company Balance only — per explicit instruction, a shop
    // sitting at zero or negative has no idle money to flag here, so it's
    // excluded entirely rather than shown with a negative/zero figure.
    if (companyBalance <= 0) continue;
    out.push({
      line: product,
      leader,
      shopName: r.agentCode,
      companyBalance,
      balanceInside: balance?.balanceInside ?? 0,
      sdp: n(r.sdp),
      noDataStreakDays: r.noDataStreakDays,
    });
  }
  return out;
}

export async function getStagnantBalanceRows(options?: { force?: boolean }): Promise<StagnantBalanceRow[]> {
  const [cashoutRows, sendMoneyRows] = await Promise.all([getStreakRowsForProduct('cashout', options), getStreakRowsForProduct('sendmoney', options)]);
  return [...cashoutRows, ...sendMoneyRows];
}

// Used by the one-time seed script — agentId lookup by product + agentCode,
// scoped so the seed never accidentally matches the wrong product's shop
// with the same bare code.
export async function getAgentIdsByCode(product: Product, agentCodes: string[]): Promise<Map<string, number>> {
  const db = getDb();
  if (agentCodes.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(and(eq(schema.agents.product, product), inArray(schema.agents.agentCode, agentCodes)));
  return new Map(rows.map((r) => [r.agentCode, r.id]));
}
