// Pure aggregation for Daily Txn Entry's "Discrepancy Summary" tab —
// deliberately framework/IO-free (no fetch, no React) so it's unit-testable
// and so switching the Cashout/Send Money/Group Total card is instant,
// client-side re-aggregation over already-fetched rows, never a refetch.
import type { DiscrepancySummaryRow } from './services/discrepancySummaryService';

export type SummaryView = 'cashout' | 'sendmoney' | 'group';

export type DiscrepancyShopEntry = {
  line: 'cashout' | 'sendmoney';
  shopName: string;
  sdp: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  walletStatus: string;
  lastActiveDate?: string | null;
};

export type DiscrepancyLeaderGroup = {
  leader: string;
  // False only when this leader exists (has at least one shop on the
  // relevant line(s)) but none of its shops have a positive Agent
  // Withdrawal — per spec, still shown as a row with "–", no chevron/
  // dropdown/count.
  hasIncludedShops: boolean;
  // Included (Agent Withdrawal > 0) shops only, already sorted per spec:
  // largest Agent Withdrawal first; for the Group Total view, every
  // Cashout shop before every Send Money shop, each block sorted largest
  // first.
  shops: DiscrepancyShopEntry[];
  sdp: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
};

export type DiscrepancySummaryTotals = {
  sdp: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
};

export type DiscrepancySummaryViewResult = {
  leaders: DiscrepancyLeaderGroup[];
  totals: DiscrepancySummaryTotals;
  // Leaders with >=1 included shop; shops counted the same way — these are
  // exactly the card subtitle's own "{leaders} leaders | {shops} shops".
  leaderCount: number;
  shopCount: number;
};

function sumIncluded(rows: DiscrepancySummaryRow[]): DiscrepancySummaryTotals {
  return rows.reduce(
    (acc, r) => ({
      sdp: acc.sdp + r.sdp,
      companyBalance: acc.companyBalance + r.companyBalance,
      balanceInside: acc.balanceInside + r.balanceInside,
      agentWithdrawal: acc.agentWithdrawal + r.agentWithdrawal,
    }),
    { sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 0 }
  );
}

function toShopEntry(r: DiscrepancySummaryRow): DiscrepancyShopEntry {
  return {
    line: r.line,
    shopName: r.shopName,
    sdp: r.sdp,
    companyBalance: r.companyBalance,
    balanceInside: r.balanceInside,
    agentWithdrawal: r.agentWithdrawal,
    walletStatus: r.walletStatus,
    lastActiveDate: r.lastActiveDate,
  };
}

const byAgentWithdrawalDesc = (a: DiscrepancySummaryRow, b: DiscrepancySummaryRow) => b.agentWithdrawal - a.agentWithdrawal;

export function buildDiscrepancySummaryView(rows: DiscrepancySummaryRow[], view: SummaryView): DiscrepancySummaryViewResult {
  const scoped = view === 'group' ? rows : rows.filter((r) => r.line === view);

  const byLeader = new Map<string, DiscrepancySummaryRow[]>();
  for (const r of scoped) {
    if (!byLeader.has(r.leader)) byLeader.set(r.leader, []);
    byLeader.get(r.leader)!.push(r);
  }

  const leaders: DiscrepancyLeaderGroup[] = [];
  for (const [leader, leaderRows] of byLeader) {
    const included = leaderRows.filter((r) => r.agentWithdrawal > 0);
    const hasIncludedShops = included.length > 0;
    const totals = sumIncluded(included);

    let shops: DiscrepancyShopEntry[];
    if (view === 'group') {
      const cashoutShops = included.filter((r) => r.line === 'cashout').sort(byAgentWithdrawalDesc);
      const sendMoneyShops = included.filter((r) => r.line === 'sendmoney').sort(byAgentWithdrawalDesc);
      shops = [...cashoutShops, ...sendMoneyShops].map(toShopEntry);
    } else {
      shops = [...included].sort(byAgentWithdrawalDesc).map(toShopEntry);
    }

    leaders.push({
      leader,
      hasIncludedShops,
      shops,
      sdp: totals.sdp,
      companyBalance: totals.companyBalance,
      balanceInside: totals.balanceInside,
      agentWithdrawal: totals.agentWithdrawal,
    });
  }

  // Leaders with included shops first (largest Agent Withdrawal first),
  // then leaders with none, A-Z.
  const withShops = leaders.filter((l) => l.hasIncludedShops).sort((a, b) => b.agentWithdrawal - a.agentWithdrawal);
  const withoutShops = leaders.filter((l) => !l.hasIncludedShops).sort((a, b) => a.leader.localeCompare(b.leader));
  const sortedLeaders = [...withShops, ...withoutShops];

  const totals = withShops.reduce(
    (acc, l) => ({
      sdp: acc.sdp + l.sdp,
      companyBalance: acc.companyBalance + l.companyBalance,
      balanceInside: acc.balanceInside + l.balanceInside,
      agentWithdrawal: acc.agentWithdrawal + l.agentWithdrawal,
    }),
    { sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 0 }
  );

  return {
    leaders: sortedLeaders,
    totals,
    leaderCount: withShops.length,
    shopCount: withShops.reduce((s, l) => s + l.shops.length, 0),
  };
}

export type DiscrepancySummaryAllViews = Record<SummaryView, DiscrepancySummaryViewResult>;

// All three views built once per fetch — the 3 selector cards always show
// their own totals regardless of which one is currently selected, per spec.
export function buildAllDiscrepancySummaryViews(rows: DiscrepancySummaryRow[]): DiscrepancySummaryAllViews {
  return {
    cashout: buildDiscrepancySummaryView(rows, 'cashout'),
    sendmoney: buildDiscrepancySummaryView(rows, 'sendmoney'),
    group: buildDiscrepancySummaryView(rows, 'group'),
  };
}
