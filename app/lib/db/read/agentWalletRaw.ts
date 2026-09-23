// Raw per-agent-wallet rows — PostgreSQL mirror of "SSP AG BalanceLimit"
// (Cashout) / "SSP PS BalanceLimit" (Send Money), the two sheets
// app/api/dashboard/route.ts used to read directly for wallet-type-level
// DP/WD aggregation (Wallet Summary's live override) and, for Send Money,
// the BD-keyword shop segregation Top Performer Wallet needs. Deliberately
// returns one row per real wallet (not pre-aggregated) so the route can
// keep its own existing aggregation logic unchanged — including Send
// Money's BD-keyword split, which needs the agent's own code, not just a
// wallet-type total — this file only swaps the row SOURCE, not any of that
// business logic.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type AgentWalletRawRow = {
  agentCode: string;
  walletTypeCode: string | null; // 'BKASH' | 'NAGAD' | 'ROCKET' | 'UPAY', null if unset
  totalDp: number;
  totalWd: number;
  balance: number;
  isLoggedIn: boolean;
};

export async function getAgentWalletRawRows(product: Product): Promise<AgentWalletRawRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      walletTypeCode: schema.walletTypes.code,
      totalDp: schema.agentWallets.totalDp,
      totalWd: schema.agentWallets.totalWd,
      balance: schema.agentWallets.balance,
      isLoggedIn: schema.agentWallets.isLoggedIn,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(eq(schema.agents.product, product));

  return rows.map((r) => ({
    agentCode: r.agentCode,
    walletTypeCode: r.walletTypeCode,
    totalDp: Number(r.totalDp ?? 0),
    totalWd: Number(r.totalWd ?? 0),
    balance: Number(r.balance ?? 0),
    isLoggedIn: r.isLoggedIn,
  }));
}
