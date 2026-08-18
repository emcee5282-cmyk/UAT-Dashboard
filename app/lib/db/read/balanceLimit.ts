// PostgreSQL read-layer mirror of the Balance Tab's own Balance-Limit
// parsing (app/agentbal/page.tsx's `balRows`, app/sendmoney/balances/
// page.tsx's identical block) — returns the SAME logical shape, one row per
// (agent, wallet type), that both pages already build client-side from the
// raw "SSP AG BalanceLimit"/"SSP PS BalanceLimit" sheet. Deliberately does
// NOT aggregate (sum totalDp/totalWd, collect status/group arrays) here —
// both pages' own existing `.forEach` aggregation logic stays completely
// unchanged, it just now iterates rows from here instead of a parsed CSV
// column-index shape. This keeps the migration limited to "where do these
// rows come from," not "how are they combined."
//
// Source data was written by the Balance Limit upload pipeline
// (app/lib/services/balanceLimitService.ts, Phase 8/8A) — shop identity is
// already resolved to agents.agent_code at upload time via the canonical
// extractRealShopName/extractSendMoneyShopName formulas, so this read layer
// never re-derives a shop name from anything; it only joins on the
// already-established agent_id relationship.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';
import { getLatestBalanceLimitImportBatch, type Product } from '../../services/balanceLimitService';

export type BalanceLimitWalletRow = {
  agentCode: string;
  accountStatus: string;
  group: string;
  walletType: string; // walletTypes.code ('BKASH'|'NAGAD'|'ROCKET'|'UPAY'), '' if unresolved
  totalDP: number;
  totalWD: number;
  balance: number;
  isLoggedIn: boolean;
};

export async function getBalanceLimitRows(product: Product): Promise<BalanceLimitWalletRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      accountStatus: schema.agentWallets.accountStatus,
      group: schema.agentWallets.groupCode,
      walletType: schema.walletTypes.code,
      totalDP: schema.agentWallets.totalDp,
      totalWD: schema.agentWallets.totalWd,
      balance: schema.agentWallets.balance,
      isLoggedIn: schema.agentWallets.isLoggedIn,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(eq(schema.agents.product, product));

  return rows.map((r) => ({
    agentCode: r.agentCode,
    accountStatus: r.accountStatus ?? '',
    group: r.group ?? '',
    walletType: r.walletType ?? '',
    totalDP: r.totalDP === null ? 0 : parseFloat(r.totalDP),
    totalWD: r.totalWD === null ? 0 : parseFloat(r.totalWD),
    balance: r.balance === null ? 0 : parseFloat(r.balance),
    isLoggedIn: r.isLoggedIn,
  }));
}

export type BalanceLimitLastImport = { fileName: string; uploadedBy: string; completedAt: string } | null;

// Exposed for future use (no existing UI slot to show it in yet, per
// explicit instruction not to add one) — reuses Phase 8A's own
// import_batches lookup rather than a second query shape.
export async function getBalanceLimitLastImport(product: Product): Promise<BalanceLimitLastImport> {
  const batch = await getLatestBalanceLimitImportBatch(product);
  if (!batch || !batch.completedAt) return null;
  return {
    fileName: batch.fileName ?? '',
    uploadedBy: batch.uploadedBy ?? '',
    completedAt: batch.completedAt.toISOString(),
  };
}
