// Data source for Pending Balance's "Unreconciled Balance" switcher —
// reuses the EXACT SAME Balance-tab queries/formulas as Discrepancy
// Summary (getAgentBalancesForBalancePage for Cashout, getAgentBalances
// for Send Money) rather than a new calculation, per explicit instruction.
// Cashout can return more than one row per shop (opening_wallet_lines
// split); each row is its own entry here too, same granularity the
// Balance tab itself displays.
import { getAgentBalances, getAgentBalancesForBalancePage, type Product } from './balanceService';

export type UnreconciledBalanceRow = {
  line: Product;
  leader: string;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  sdp: number;
  // "WITHHELD BALANCE" on the page/export/images — the Balance tab's own
  // SDP vs Balance figure (computeSdpVsBalance in balanceEngine.ts),
  // reused unchanged, never recomputed here.
  sdpVsBalance: number;
};

// Same two placeholder leader names Discrepancy Summary excludes (see
// discrepancySummaryService.ts's own comment) — "NEW SHOP" and
// "NEW-TEMPAUTOPLOT" — plus a genuinely blank leader, which Discrepancy
// Summary never needed to check since every row there already has a real
// leader by the time it's positive-filtered; Unreconciled includes every
// row regardless of Agent Withdrawal sign, so a blank leader can surface
// here for the first time.
const EXCLUDED_LEADER_NAMES = new Set(['NEW SHOP', 'NEW-TEMPAUTOPLOT']);

export async function getUnreconciledBalanceRows(options?: { force?: boolean }): Promise<UnreconciledBalanceRow[]> {
  const [cashoutRows, sendMoneyRows] = await Promise.all([
    getAgentBalancesForBalancePage('cashout', options),
    getAgentBalances('sendmoney', options),
  ]);

  const rows: UnreconciledBalanceRow[] = [];

  for (const r of cashoutRows) {
    if (!r.leader.trim() || EXCLUDED_LEADER_NAMES.has(r.leader)) continue;
    rows.push({
      line: 'cashout',
      leader: r.leader,
      companyBalance: r.companyBalance,
      balanceInside: r.balanceInside,
      agentWithdrawal: r.agentWithdrawal,
      sdp: r.sdp,
      sdpVsBalance: r.sdpVsBalance,
    });
  }

  for (const r of sendMoneyRows) {
    if (!r.leader.trim() || EXCLUDED_LEADER_NAMES.has(r.leader)) continue;
    rows.push({
      line: 'sendmoney',
      leader: r.leader,
      companyBalance: r.companyBalance,
      balanceInside: r.balanceInside,
      agentWithdrawal: r.agentWithdrawal,
      sdp: r.sdp,
      sdpVsBalance: r.sdpVsBalance,
    });
  }

  return rows;
}
