// Pure aggregation for Pending Balance's "Unreconciled Balance" switcher —
// framework/IO-free (no fetch, no React) so switching Cashout/Send Money/
// Group Total is instant client-side re-aggregation over already-fetched
// rows, never a refetch — same convention as discrepancySummaryAggregate.ts.
//
// Unlike Discrepancy Summary, every shop is included here (positive, zero
// AND negative together — negatives reduce the leader's total, never
// filtered out), and there is no shop-level drill-down: one row per
// leader only.
import type { UnreconciledBalanceRow } from './services/unreconciledBalanceService';

export type UnreconciledView = 'cashout' | 'sendmoney' | 'group';

export type UnreconciledLeaderRow = {
  leader: string;
  // Shops included for that leader in the current view — Group Total
  // sums the Cashout and Send Money counts, same as every other field.
  shopCount: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  sdp: number;
  sdpVsBalance: number;
};

export type UnreconciledSortKey = 'leader' | 'companyBalance' | 'balanceInside' | 'agentWithdrawal' | 'sdp' | 'sdpVsBalance';

function emptyLeaderRow(leader: string): UnreconciledLeaderRow {
  return { leader, shopCount: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 0, sdp: 0, sdpVsBalance: 0 };
}

function aggregateByLeader(rows: UnreconciledBalanceRow[]): Map<string, UnreconciledLeaderRow> {
  const map = new Map<string, UnreconciledLeaderRow>();
  for (const r of rows) {
    const existing = map.get(r.leader) ?? emptyLeaderRow(r.leader);
    existing.shopCount += 1;
    existing.companyBalance += r.companyBalance;
    existing.balanceInside += r.balanceInside;
    existing.agentWithdrawal += r.agentWithdrawal;
    existing.sdp += r.sdp;
    existing.sdpVsBalance += r.sdpVsBalance;
    map.set(r.leader, existing);
  }
  return map;
}

// Default order for every consumer (page's initial render, export, TG
// images) — largest TOTAL DISCREPANCY (Agent Withdrawal) first. The page
// itself can re-sort client-side by any column; this is just the
// unsorted-by-the-user starting point.
const byAgentWithdrawalDesc = (a: UnreconciledLeaderRow, b: UnreconciledLeaderRow) => b.agentWithdrawal - a.agentWithdrawal;

export function buildUnreconciledView(rows: UnreconciledBalanceRow[], view: UnreconciledView): UnreconciledLeaderRow[] {
  if (view === 'group') {
    const cashoutMap = aggregateByLeader(rows.filter((r) => r.line === 'cashout'));
    const sendMoneyMap = aggregateByLeader(rows.filter((r) => r.line === 'sendmoney'));
    const leaders = new Set([...cashoutMap.keys(), ...sendMoneyMap.keys()]);
    const result: UnreconciledLeaderRow[] = [];
    for (const leader of leaders) {
      const c = cashoutMap.get(leader) ?? emptyLeaderRow(leader);
      const s = sendMoneyMap.get(leader) ?? emptyLeaderRow(leader);
      result.push({
        leader,
        shopCount: c.shopCount + s.shopCount,
        companyBalance: c.companyBalance + s.companyBalance,
        balanceInside: c.balanceInside + s.balanceInside,
        agentWithdrawal: c.agentWithdrawal + s.agentWithdrawal,
        sdp: c.sdp + s.sdp,
        sdpVsBalance: c.sdpVsBalance + s.sdpVsBalance,
      });
    }
    return result.sort(byAgentWithdrawalDesc);
  }

  const scoped = rows.filter((r) => r.line === view);
  return Array.from(aggregateByLeader(scoped).values()).sort(byAgentWithdrawalDesc);
}

export type UnreconciledAllViews = Record<UnreconciledView, UnreconciledLeaderRow[]>;

export function buildAllUnreconciledViews(rows: UnreconciledBalanceRow[]): UnreconciledAllViews {
  return {
    cashout: buildUnreconciledView(rows, 'cashout'),
    sendmoney: buildUnreconciledView(rows, 'sendmoney'),
    group: buildUnreconciledView(rows, 'group'),
  };
}

// The Total row — callers pass whatever subset is currently visible (e.g.
// after a search filter), so the Total always matches what's on screen,
// per explicit instruction ("respects the search filter").
export function sumUnreconciledRows(rows: UnreconciledLeaderRow[]): Omit<UnreconciledLeaderRow, 'leader'> {
  return rows.reduce(
    (acc, r) => ({
      shopCount: acc.shopCount + r.shopCount,
      companyBalance: acc.companyBalance + r.companyBalance,
      balanceInside: acc.balanceInside + r.balanceInside,
      agentWithdrawal: acc.agentWithdrawal + r.agentWithdrawal,
      sdp: acc.sdp + r.sdp,
      sdpVsBalance: acc.sdpVsBalance + r.sdpVsBalance,
    }),
    { shopCount: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 0, sdp: 0, sdpVsBalance: 0 }
  );
}

export function sortUnreconciledRows(rows: UnreconciledLeaderRow[], key: UnreconciledSortKey, direction: 'asc' | 'desc'): UnreconciledLeaderRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (key === 'leader') return a.leader.localeCompare(b.leader);
    return a[key] - b[key];
  });
  if (direction === 'desc') sorted.reverse();
  return sorted;
}
