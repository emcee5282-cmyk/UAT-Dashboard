// One-off: zero out Opening Balance + SDP (agents) AND every numeric field
// the "Balance Limit" upload/sheet populates on agent_wallets (balance,
// total_dp, total_wd, dp_limit) for every row, both products — per explicit
// instruction ("may laman pa din" — Total DP/Total WD/Actual Balance are
// sourced from the same Balance Limit upload as dp_limit, so all 4 columns
// need to reset together, not just dp_limit alone). Plain value resets, no
// deletes, no FK concerns.
//
// Run with:  npx tsx --env-file=.env.local scripts/zero-opening-and-balance-limit.ts

import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();

  console.log('Zeroing agents.opening_balance and agents.sdp (all products)...');
  const openingReset = await db
    .update(schema.agents)
    .set({ openingBalance: '0', sdp: '0', updatedAt: new Date() })
    .returning({ id: schema.agents.id });
  console.log(`  reset ${openingReset.length} agent rows`);

  console.log('Zeroing agent_wallets.balance/total_dp/total_wd/dp_limit (Balance Limit, all products)...');
  const dpLimitReset = await db
    .update(schema.agentWallets)
    .set({ balance: '0', totalDp: '0', totalWd: '0', dpLimit: '0', updatedAt: new Date() })
    .returning({ id: schema.agentWallets.id });
  console.log(`  reset ${dpLimitReset.length} agent_wallets rows`);

  const openingCounts = await db
    .select({ product: schema.agents.product, count: sql<number>`count(*)::int` })
    .from(schema.agents)
    .groupBy(schema.agents.product);
  console.log('agents total per product:', openingCounts);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
