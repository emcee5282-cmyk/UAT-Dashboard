// Pure aggregation for Pending Balance's "Stagnant Balances" tab — mirrors
// discrepancySummaryAggregate.ts's own per-leader/collapsible-shops shape
// (not unreconciledBalanceAggregate.ts's flat one-row-per-leader shape),
// since this tab needs the same expand-to-see-shops interaction. The one
// real difference: shops within an expanded leader sort by streak length
// (longest-stagnant first), never by any balance figure.
import type { StagnantBalanceRow, StagnantRecoveredEntry } from './services/stagnantBalanceService';

export type StagnantView = 'cashout' | 'sendmoney' | 'group';

export type StagnantShopEntry = {
  line: 'cashout' | 'sendmoney';
  shopName: string;
  companyBalance: number;
  balanceInside: number;
  sdp: number;
  settlementToday: number;
  recovered: number;
  noDataStreakDays: number;
};

export type StagnantLeaderGroup = {
  leader: string;
  shops: StagnantShopEntry[];
  companyBalance: number;
  balanceInside: number;
  sdp: number;
  settlementToday: number;
  recovered: number;
  shopCount: number;
};

// 4 day-range buckets (3-6 / 7-9 / 10-14 / 15+ days, "No data" folded into
// 15+ — per explicit instruction) — Company Balance summed per bucket
// across every stagnant shop in the view, for the summary band above the
// table.
export type StagnantBuckets = {
  threeDaysAbove: number;
  sixDaysAbove: number;
  tenDaysAbove: number;
  fifteenDaysAbove: number;
  total: number;
  // Month-to-date Settlement of every shop since it was first posted here
  // this month (see StagnantRecoveredEntry) — includes shops no longer on
  // the page, so it is NOT derived from the rows above.
  recovered: number;
};

export type StagnantViewResult = {
  leaders: StagnantLeaderGroup[];
  totals: { companyBalance: number; balanceInside: number; sdp: number; settlementToday: number; recovered: number; shopCount: number };
  buckets: StagnantBuckets;
  // Cashout's per-wallet streak (see stagnantBalanceService.ts's own header
  // comment) — the latest upload cutoff date it was evaluated against. null
  // when the view has no Cashout rows (a pure Send Money view, or empty).
  cashoutDaysAsOf: string | null;
};

function toShopEntry(r: StagnantBalanceRow): StagnantShopEntry {
  return { line: r.line, shopName: r.shopName, companyBalance: r.companyBalance, balanceInside: r.balanceInside, sdp: r.sdp, settlementToday: r.settlementToday, recovered: r.recovered, noDataStreakDays: r.noDataStreakDays };
}

function buildBuckets(rows: StagnantBalanceRow[], recovered: StagnantRecoveredEntry[]): StagnantBuckets {
  const buckets: StagnantBuckets = { threeDaysAbove: 0, sixDaysAbove: 0, tenDaysAbove: 0, fifteenDaysAbove: 0, total: 0, recovered: 0 };
  for (const e of recovered) buckets.recovered += e.amount;
  for (const r of rows) {
    if (r.noDataStreakDays <= 6) buckets.threeDaysAbove += r.companyBalance;
    else if (r.noDataStreakDays <= 9) buckets.sixDaysAbove += r.companyBalance;
    else if (r.noDataStreakDays <= 14) buckets.tenDaysAbove += r.companyBalance;
    else buckets.fifteenDaysAbove += r.companyBalance;
    buckets.total += r.companyBalance;
  }
  return buckets;
}

const byStreakDesc = (a: StagnantBalanceRow, b: StagnantBalanceRow) => b.noDataStreakDays - a.noDataStreakDays;

export function buildStagnantView(rows: StagnantBalanceRow[], recovered: StagnantRecoveredEntry[], view: StagnantView): StagnantViewResult {
  const scoped = view === 'group' ? rows : rows.filter((r) => r.line === view);
  const scopedRecovered = view === 'group' ? recovered : recovered.filter((e) => e.line === view);

  const byLeader = new Map<string, StagnantBalanceRow[]>();
  for (const r of scoped) {
    if (!byLeader.has(r.leader)) byLeader.set(r.leader, []);
    byLeader.get(r.leader)!.push(r);
  }

  const leaders: StagnantLeaderGroup[] = [];
  for (const [leader, leaderRows] of byLeader) {
    let shops: StagnantShopEntry[];
    if (view === 'group') {
      const cashoutShops = leaderRows.filter((r) => r.line === 'cashout').sort(byStreakDesc);
      const sendMoneyShops = leaderRows.filter((r) => r.line === 'sendmoney').sort(byStreakDesc);
      shops = [...cashoutShops, ...sendMoneyShops].map(toShopEntry);
    } else {
      shops = [...leaderRows].sort(byStreakDesc).map(toShopEntry);
    }

    leaders.push({
      leader,
      shops,
      companyBalance: leaderRows.reduce((sum, r) => sum + r.companyBalance, 0),
      balanceInside: leaderRows.reduce((sum, r) => sum + r.balanceInside, 0),
      sdp: leaderRows.reduce((sum, r) => sum + r.sdp, 0),
      settlementToday: leaderRows.reduce((sum, r) => sum + r.settlementToday, 0),
      recovered: leaderRows.reduce((sum, r) => sum + r.recovered, 0),
      shopCount: leaderRows.length,
    });
  }

  // Highest Company Balance first — per explicit instruction, not shop
  // count — ties broken A-Z.
  const sortedLeaders = leaders.sort((a, b) => b.companyBalance - a.companyBalance || a.leader.localeCompare(b.leader));

  const totals = sortedLeaders.reduce(
    (acc, l) => ({ companyBalance: acc.companyBalance + l.companyBalance, balanceInside: acc.balanceInside + l.balanceInside, sdp: acc.sdp + l.sdp, settlementToday: acc.settlementToday + l.settlementToday, recovered: acc.recovered + l.recovered, shopCount: acc.shopCount + l.shopCount }),
    { companyBalance: 0, balanceInside: 0, sdp: 0, settlementToday: 0, recovered: 0, shopCount: 0 }
  );

  // Latest evaluated cutoff across rows — live-updated per wallet now, so
  // rows can legitimately carry different dates (e.g. a stale key).
  const cashoutDaysAsOf = scoped.reduce<string | null>((max, r) => (r.line === 'cashout' && r.daysAsOf && (!max || r.daysAsOf > max) ? r.daysAsOf : max), null);

  return { leaders: sortedLeaders, totals, buckets: buildBuckets(scoped, scopedRecovered), cashoutDaysAsOf };
}

export type StagnantAllViews = Record<StagnantView, StagnantViewResult>;

export function buildAllStagnantViews(rows: StagnantBalanceRow[], recovered: StagnantRecoveredEntry[]): StagnantAllViews {
  return {
    cashout: buildStagnantView(rows, recovered, 'cashout'),
    sendmoney: buildStagnantView(rows, recovered, 'sendmoney'),
    group: buildStagnantView(rows, recovered, 'group'),
  };
}
