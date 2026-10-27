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
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getAgentBalances, getAgentBalancesForBalancePage } from './balanceService';
import { extractOpeningWalletTypeSuffix } from '../realShopName';
import { getBusinessToday, manilaFields } from '../businessDate';

export type Product = 'cashout' | 'sendmoney';

export const STAGNANT_THRESHOLD_DAYS = 3;

const EXCLUDED_LEADER_NAMES = new Set(['NEW SHOP', 'NEW-TEMPAUTOPLOT']);

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

// Positive AND still positive once rounded the way the page displays it —
// a sub-0.5 leftover would otherwise show as a "–" Company Balance row.
function hasDisplayableBalance(companyBalance: number): boolean {
  return Math.round(companyBalance) > 0;
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
  // This shop's (wallet line's, for a split Cashout shop) Settlement dated
  // today (Manila business date) — 0 when none.
  settlementToday: number;
  // This shop's month-to-date Settlement since it was first posted here
  // (same figure as its StagnantRecoveredEntry) — Excel export only.
  recovered: number;
};

// One shop/wallet line's month-to-date Settlement since it was first
// posted on Stagnant Balances this month — includes shops that have since
// dropped off the page (usually BECAUSE that settlement took Company
// Balance to <= 0). Feeds the summary band's "Recovered" figure.
export type StagnantRecoveredEntry = {
  line: Product;
  leader: string;
  shopName: string;
  amount: number;
};

// Internal: a page row plus the keys needed to match it against
// settlements/postings — stripped before leaving this file.
type KeyedStagnantRow = Omit<StagnantBalanceRow, 'settlementToday' | 'recovered'> & {
  agentId: number;
  walletSuffix: string;
  // Cutoff date the streak was last evaluated against ('YYYY-MM-DD').
  streakAsOf: string | null;
};

// Same Company Balance/Balance Inside source — AND the same displayed shop
// NAME — as Discrepancy Summary/Unreconciled Balance, per explicit
// instruction: whatever name the Balance tab shows for a shop is what this
// page must show too, not the bare agentCode.
type NamedBalanceLine = { agentId: number; displayName: string; companyBalance: number; balanceInside: number; sdp: number };

async function getCashoutStreakRows(options?: { force?: boolean }): Promise<KeyedStagnantRow[]> {
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

  const out: KeyedStagnantRow[] = [];
  for (const r of streakRows) {
    const leader = (r.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const balance = balanceLinesByKey.get(`${r.agentId}|${r.walletSuffix}`);
    if (!balance) continue;
    // Positive Company Balance only — per explicit instruction, a
    // wallet/shop sitting at zero or negative has no idle money to flag
    // here, so it's excluded entirely rather than shown with a
    // negative/zero figure. "Zero" = rounds to 0 on the page (e.g. 0.36
    // displays as "–"), not just exactly 0.
    if (!hasDisplayableBalance(balance.companyBalance)) continue;
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
      agentId: r.agentId,
      walletSuffix: r.walletSuffix,
      streakAsOf: r.fileAsOfDate,
    });
  }
  return out;
}

async function getSendMoneyStreakRows(options?: { force?: boolean }): Promise<KeyedStagnantRow[]> {
  const db = getDb();

  const streakRowsPromise = db
    .select({
      agentId: schema.agents.id,
      sdp: schema.agents.sdp,
      leaderName: schema.leaders.name,
      noDataStreakDays: schema.stagnantBalanceTracking.noDataStreakDays,
      lastCheckedCutoffDate: schema.stagnantBalanceTracking.lastCheckedCutoffDate,
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

  const out: KeyedStagnantRow[] = [];
  for (const r of streakRows) {
    const leader = (r.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const balance = balanceByAgentId.get(r.agentId);
    if (!balance || !hasDisplayableBalance(balance.companyBalance)) continue;
    out.push({
      line: 'sendmoney',
      leader,
      shopName: balance.displayName,
      companyBalance: balance.companyBalance,
      balanceInside: balance.balanceInside,
      sdp: n(r.sdp),
      noDataStreakDays: r.noDataStreakDays,
      daysAsOf: null,
      agentId: r.agentId,
      walletSuffix: '',
      streakAsOf: r.lastCheckedCutoffDate,
    });
  }
  return out;
}

// Same abbreviation -> wallet_transactions.wallet mapping as
// balanceService.ts's own (used there to attribute a split shop's Top Up/
// Settlement to the one wallet line it belongs to).
const SUFFIX_TO_WALLET: Record<string, string> = { BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY' };

function isoDate(date: Date): string {
  const { year, month, day } = manilaFields(date);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The day this shop crossed the threshold, estimated from its streak: a
// streak of N evaluated at cutoff X first reached the threshold N -
// threshold days before X. Only an estimate (the streak tables keep no
// history) — the earliest value seen within a month is the one kept.
function estimateFirstPostedOn(row: KeyedStagnantRow, today: string): string {
  return shiftIsoDate(row.streakAsOf ?? today, -(row.noDataStreakDays - STAGNANT_THRESHOLD_DAYS));
}

type SettlementTx = { agentId: number; wallet: string | null; amount: number; occurredOn: string };

function settlementMatches(tx: SettlementTx, walletSuffix: string): boolean {
  // '' = unsplit shop (or Send Money) — every wallet's settlement is its own.
  if (!walletSuffix) return true;
  return (tx.wallet ?? '').toUpperCase() === SUFFIX_TO_WALLET[walletSuffix];
}

export type StagnantBalanceResult = { rows: StagnantBalanceRow[]; recovered: StagnantRecoveredEntry[] };

// `asOfDate` ('YYYY-MM-DD') pins "today" to a given business date instead
// of the current one — the 2AM Telegram send runs right after the business
// day rolls over, so it reports the day that just ended (its Settlement,
// and Recovered month-to-date through it).
export async function getStagnantBalanceRows(options?: { force?: boolean; asOfDate?: string }): Promise<StagnantBalanceResult> {
  const db = getDb();
  const today = options?.asOfDate ?? isoDate(getBusinessToday());
  const monthStart = `${today.slice(0, 7)}-01`;

  const [cashoutRows, sendMoneyRows, settlementRows] = await Promise.all([
    getCashoutStreakRows(options),
    getSendMoneyStreakRows(options),
    db
      .select({
        agentId: schema.walletTransactions.agentId,
        wallet: schema.walletTransactions.wallet,
        amount: schema.walletTransactions.amount,
        occurredOn: schema.walletTransactions.occurredOn,
      })
      .from(schema.walletTransactions)
      .where(and(
        eq(schema.walletTransactions.transactionType, 'settlement'),
        gte(schema.walletTransactions.occurredOn, monthStart),
        lte(schema.walletTransactions.occurredOn, today)
      )),
  ]);
  const keyedRows = [...cashoutRows, ...sendMoneyRows];

  const settlementsByAgent = new Map<number, SettlementTx[]>();
  for (const t of settlementRows) {
    if (!settlementsByAgent.has(t.agentId)) settlementsByAgent.set(t.agentId, []);
    settlementsByAgent.get(t.agentId)!.push({ agentId: t.agentId, wallet: t.wallet, amount: n(t.amount), occurredOn: t.occurredOn });
  }
  const sumSettlement = (agentId: number, walletSuffix: string, from: string) =>
    (settlementsByAgent.get(agentId) ?? [])
      .filter((t) => t.occurredOn >= from && settlementMatches(t, walletSuffix))
      .reduce((sum, t) => sum + t.amount, 0);

  // Remember every shop on the page right now (see stagnantBalancePostings'
  // own schema comment). A posting last seen before this month starts the
  // month fresh from this read's estimate; otherwise the earliest estimate
  // this month wins.
  const postings = schema.stagnantBalancePostings;
  for (let i = 0; i < keyedRows.length; i += 500) {
    const chunk = keyedRows.slice(i, i + 500);
    await db
      .insert(postings)
      .values(chunk.map((r) => ({
        product: r.line,
        agentId: r.agentId,
        walletSuffix: r.walletSuffix,
        shopName: r.shopName,
        firstPostedOn: estimateFirstPostedOn(r, today),
        lastSeenOn: today,
      })))
      .onConflictDoUpdate({
        target: [postings.agentId, postings.walletSuffix],
        set: {
          product: sql`excluded.product`,
          shopName: sql`excluded.shop_name`,
          firstPostedOn: sql`CASE WHEN ${postings.lastSeenOn} < ${monthStart} THEN excluded.first_posted_on ELSE LEAST(${postings.firstPostedOn}, excluded.first_posted_on) END`,
          lastSeenOn: sql`GREATEST(${postings.lastSeenOn}, excluded.last_seen_on)`,
          updatedAt: sql`now()`,
        },
      });
  }

  const monthPostings = await db
    .select({
      product: postings.product,
      agentId: postings.agentId,
      walletSuffix: postings.walletSuffix,
      shopName: postings.shopName,
      firstPostedOn: postings.firstPostedOn,
      leaderName: schema.leaders.name,
    })
    .from(postings)
    .innerJoin(schema.agents, eq(postings.agentId, schema.agents.id))
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(gte(postings.lastSeenOn, monthStart));

  const recovered: StagnantRecoveredEntry[] = [];
  const recoveredByKey = new Map<string, number>();
  for (const p of monthPostings) {
    const leader = (p.leaderName ?? '').trim();
    if (!leader || EXCLUDED_LEADER_NAMES.has(leader.toUpperCase())) continue;
    const from = p.firstPostedOn > monthStart ? p.firstPostedOn : monthStart;
    const amount = sumSettlement(p.agentId, p.walletSuffix, from);
    recoveredByKey.set(`${p.agentId}|${p.walletSuffix}`, amount);
    if (amount > 0) recovered.push({ line: p.product, leader, shopName: p.shopName, amount });
  }

  const rows: StagnantBalanceRow[] = keyedRows.map((r) => ({
    line: r.line,
    leader: r.leader,
    shopName: r.shopName,
    companyBalance: r.companyBalance,
    balanceInside: r.balanceInside,
    sdp: r.sdp,
    noDataStreakDays: r.noDataStreakDays,
    daysAsOf: r.daysAsOf,
    settlementToday: sumSettlement(r.agentId, r.walletSuffix, today),
    recovered: recoveredByKey.get(`${r.agentId}|${r.walletSuffix}`) ?? 0,
  }));
  return { rows, recovered };
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
