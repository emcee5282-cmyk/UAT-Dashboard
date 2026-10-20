// Data source for Daily Transaction Entry's "Discrepancy Summary" tab —
// reuses the exact same Balance-tab queries/formulas (getAgentBalancesForBalancePage
// for Cashout, getAgentBalances for Send Money) rather than a new calculation,
// per explicit instruction. Cashout can return more than one row per shop
// (opening_wallet_lines split — see getAgentBalancesForBalancePage's own
// comment); each row is treated as its own "shop" entry here, matching the
// Balance tab's own displayed granularity exactly.
import { getAgentBalances, getAgentBalancesForBalancePage, type Product } from './balanceService';

export type DiscrepancySummaryRow = {
  agentId: number;
  line: Product;
  leader: string;
  shopName: string;
  sdp: number;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  // The Balance tab's own Wallet Status, verbatim (login override already
  // applied) — the TG image collapses it to Active/Disconnected.
  walletStatus: string;
  // 'YYYY-MM-DD' last WD day (lastActiveLabel.ts) — never set here; only
  // the TG send attaches it (one extra query the Summary tab doesn't need).
  lastActiveDate?: string | null;
};

// Two distinct placeholder leader names exist in the data (see
// importService.ts's own PLACEHOLDER_LEADER_NAMES): "NEW SHOP" and
// "NEW-TEMPAUTOPLOT" — both auto-assigned to a shop with no real leader
// yet. Per explicit instruction, excluded entirely from this tab (not
// even as a "–" dash row, regardless of whether any of its shops have a
// positive Agent Withdrawal) since these are temporary and will get a
// real leader assigned soon.
const EXCLUDED_LEADER_NAMES = new Set(['NEW SHOP', 'NEW-TEMPAUTOPLOT']);

export async function getDiscrepancySummaryRows(options?: { force?: boolean }): Promise<DiscrepancySummaryRow[]> {
  const [cashoutRows, sendMoneyRows] = await Promise.all([
    getAgentBalancesForBalancePage('cashout', options),
    getAgentBalances('sendmoney', options),
  ]);

  const rows: DiscrepancySummaryRow[] = [];

  for (const r of cashoutRows) {
    if (EXCLUDED_LEADER_NAMES.has(r.leader)) continue;
    rows.push({
      agentId: r.agentId,
      line: 'cashout',
      leader: r.leader,
      shopName: r.displayName,
      sdp: r.sdp,
      companyBalance: r.companyBalance,
      balanceInside: r.balanceInside,
      agentWithdrawal: r.agentWithdrawal,
      walletStatus: r.walletStatus,
    });
  }

  for (const r of sendMoneyRows) {
    if (EXCLUDED_LEADER_NAMES.has(r.leader)) continue;
    rows.push({
      agentId: r.agentId,
      line: 'sendmoney',
      leader: r.leader,
      shopName: r.agentCode,
      sdp: r.sdp,
      companyBalance: r.companyBalance,
      balanceInside: r.balanceInside,
      agentWithdrawal: r.agentWithdrawal,
      walletStatus: r.walletStatus,
    });
  }

  return rows;
}
