// Pending Balance > Stagnant Balances. Only agents that have ACTUALLY
// crossed the 3-day "stagnant" threshold are returned — a shop at 0/1/2
// days isn't stagnant yet and shouldn't appear anywhere on this page, not
// even as a zero-count row under its own leader.
//
// Cashout and Send Money source their streak very differently as of
// 2026-10-16 (see scripts/_seed-stagnant-balance-from-file.ts's own header
// comment for the full reasoning):
//   - Send Money reads stagnant_balance_tracking, kept live by
//     importEstimatedOpeningFromUpload() on every Estimated Balance
//     upload — unchanged, since its real upload data is shop-level 1:1.
//   - Cashout reads stagnant_balance_wallet_streak instead — per wallet,
//     since a per-shop streak masks a genuinely idle wallet whenever a
//     sibling wallet is still active. Seeded once from the reference file
//     (2026-10-16), then kept live per wallet by the same Estimated
//     Balance upload hook (no longer frozen, as of 2026-10-20). daysAsOf
//     is the last upload cutoff date the row was evaluated against.
import { eq, and, gte, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getAgentBalances, getAgentBalancesForBalancePage } from './balanceService';
import { extractOpeningWalletTypeSuffix } from '../realShopName';

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
  // The file's own run date, Cashout only — null for Send Money (still
  // live). Lets the UI label Cashout's figures as a file snapshot.
  daysAsOf: string | null;
};

// Same Company Balance/Balance Inside source — AND the same displayed shop
// NAME — as Discrepancy Summary/Unreconciled Balance, per explicit
// instruction: whatever name the Balance tab shows for a shop is what this
// page must show too, not the bare agentCode.
type NamedBalanceLine = { agentId: number; displayName: string; companyBalance: number; balanceInside: number; sdp: number };

async function getCashoutStreakRows(options?: { force?: boolean }): Promise<StagnantBalanceRow[]> {
  const db = getDb();

  const streakRowsPromise = db
    .select({
      agentId: schema.agents.id,
      walletSuffix: schema.stagnantBalanceWalletStreak.walletSuffix,
      leaderName: schema.leaders.name,
      noDataStreakDays: schema.stagnantBalanceWalletStreak.noDataStreakDays,
      fileAsOfDate: schema.stagnantBalanceWalletStreak.fileAsOfDate,
    })
    .from(schema.stagnantBalanceWalletStreak)
    .innerJoin(schema.agents, eq(schema.stagnantBalanceWalletStreak.agentId, schema.agents.id))
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(
      eq(schema.agents.product, 'cashout'),
      eq(schema.agents.isActive, true),
      gte(schema.stagnantBalanceWalletStreak.noDataStreakDays, STAGNANT_THRESHOLD_DAYS)
    ));

  const balanceLinesPromise = getAgentBalancesForBalancePage('cashout', options).then((rows) =>
    rows.map((b) => ({ agentId: b.agentId, displayName: b.displayName, companyBalance: b.companyBalance, balanceInside: b.balanceInside, sdp: b.sdp }))
  );

  const [streakRows, balanceLines] = await Promise.all([streakRowsPromise, balanceLinesPromise]);

  // Keyed by agentId + that line's OWN wallet suffix (extracted the exact
  // same way the seed script extracted it from the file) — a shop Opening
  // split into multiple wallet lines gets exactly one balance line per
  // wallet, matched 1:1 against its own file-seeded streak row instead of
  // sharing one shop-level number across every wallet (the old, coarser
  // behavior this replaces). An unsplit shop's single line has no
  // detectable suffix (extractOpeningWalletTypeSuffix returns null), same
  // '' fallback the seed script used for that shape.
  const balanceLinesByKey = new Map<string, NamedBalanceLine>();
  for (const b of balanceLines) {
    const suffix = extractOpeningWalletTypeSuffix(b.displayName) ?? '';
    balanceLinesByKey.set(`${b.agentId}|${suffix}`, b);
  }

  const out: StagnantBalanceRow[] = [];
  for (const r of streakRows) {
    const leader = (r.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const balance = balanceLinesByKey.get(`${r.agentId}|${r.walletSuffix}`);
    if (!balance) continue;
    // Positive Company Balance only — per explicit instruction, a
    // wallet/shop sitting at zero or negative has no idle money to flag
    // here, so it's excluded entirely rather than shown with a
    // negative/zero figure.
    if (balance.companyBalance <= 0) continue;
    out.push({
      line: 'cashout',
      leader,
      shopName: balance.displayName,
      companyBalance: balance.companyBalance,
      balanceInside: balance.balanceInside,
      // This wallet line's OWN SDP (same figure Opening and the Balance tab
      // show for it), not the whole shop's agents.sdp — that total repeated
      // on every wallet row of a split shop double-counted it in the
      // leader/group SDP totals (e.g. BERLIN 6.0M shown vs 2.2M real).
      sdp: balance.sdp,
      noDataStreakDays: r.noDataStreakDays,
      daysAsOf: r.fileAsOfDate,
    });
  }
  return out;
}

async function getSendMoneyStreakRows(options?: { force?: boolean }): Promise<StagnantBalanceRow[]> {
  const db = getDb();

  const streakRowsPromise = db
    .select({
      agentId: schema.agents.id,
      sdp: schema.agents.sdp,
      leaderName: schema.leaders.name,
      noDataStreakDays: schema.stagnantBalanceTracking.noDataStreakDays,
    })
    .from(schema.stagnantBalanceTracking)
    .innerJoin(schema.agents, eq(schema.stagnantBalanceTracking.agentId, schema.agents.id))
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(
      eq(schema.agents.product, 'sendmoney'),
      eq(schema.agents.isActive, true),
      gte(schema.stagnantBalanceTracking.noDataStreakDays, STAGNANT_THRESHOLD_DAYS)
    ));

  // Send Money has no per-wallet split at all (confirmed:
  // getAgentBalancesForBalancePage's own header comment), so it keeps the
  // plain getAgentBalances() source, one line per agent.
  const balanceLinesPromise: Promise<NamedBalanceLine[]> = getAgentBalances('sendmoney', options).then((rows) =>
    rows.map((b) => ({ agentId: b.agentId, displayName: b.agentCode, companyBalance: b.companyBalance, balanceInside: b.balanceInside, sdp: b.sdp }))
  );

  const [streakRows, balanceLines] = await Promise.all([streakRowsPromise, balanceLinesPromise]);
  const balanceByAgentId = new Map(balanceLines.map((b) => [b.agentId, b]));

  const out: StagnantBalanceRow[] = [];
  for (const r of streakRows) {
    const leader = (r.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const balance = balanceByAgentId.get(r.agentId);
    if (!balance || balance.companyBalance <= 0) continue;
    out.push({
      line: 'sendmoney',
      leader,
      shopName: balance.displayName,
      companyBalance: balance.companyBalance,
      balanceInside: balance.balanceInside,
      sdp: n(r.sdp),
      noDataStreakDays: r.noDataStreakDays,
      daysAsOf: null,
    });
  }
  return out;
}

export async function getStagnantBalanceRows(options?: { force?: boolean }): Promise<StagnantBalanceRow[]> {
  const [cashoutRows, sendMoneyRows] = await Promise.all([
    getCashoutStreakRows(options),
    getSendMoneyStreakRows(options),
  ]);
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
