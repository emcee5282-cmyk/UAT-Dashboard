// Server-side Wallet Status service — LOCAL/FOUNDATION ONLY, not wired
// into any existing page or route.
//
// Reuses two already-built, unmodified pieces directly:
//   - getAgentBalances()'s own `walletStatus` field (this file's own
//     balanceService.ts), which already calls balanceEngine.ts's real
//     computeWalletStatus() — the LIVE, account-status-derived status.
//   - readWalletStatusOverridesPg() (app/lib/db/read/walletStatus.ts,
//     built earlier this session), which already reproduces the exact
//     merged-override shape app/lib/walletStatus.ts's own
//     mergeWalletStatusRemarksAndOverrides() produces.
// This file only combines the two — no new business logic.
import { getAgentBalances, type Product } from './balanceService';
import { readWalletStatusOverridesPg, type MergedWalletSettingsEntry } from '../db/read/walletStatus';

export type WalletStatusRow = {
  agentId: number;
  agentCode: string;
  leader: string;
  brand: string;
  liveWalletStatus: string; // computed from live account_status (balanceEngine.ts)
  override: MergedWalletSettingsEntry | null; // staff-entered override, if any
};

export async function getWalletStatusRows(product: Product): Promise<WalletStatusRow[]> {
  const [balances, overrides] = await Promise.all([
    getAgentBalances(product),
    readWalletStatusOverridesPg(product),
  ]);

  return balances.map((b) => ({
    agentId: b.agentId,
    agentCode: b.agentCode,
    leader: b.leader,
    brand: b.brand,
    liveWalletStatus: b.walletStatus,
    override: overrides[b.agentCode] ?? null,
  }));
}
