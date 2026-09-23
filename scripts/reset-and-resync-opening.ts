// One-off: reset every agent's Opening Balance + SDP to 0, then re-sync
// TODAY's real values from the "Opening AG" Google Sheet — per explicit
// instruction. A shop that isn't in today's sheet (or is genuinely 0/0
// there) simply stays at the reset 0/0 value; no separate delete step is
// needed (agents.id is referenced, without cascade, by agent_wallets/
// wallet_transactions/etc., so a literal DELETE would fail for any shop
// with existing wallet data anyway — reset-then-resync sidesteps that
// entirely).
//
// Reuses migrate-data.ts's own importAgents(product) verbatim (same
// "Opening AG!A2:D" / "Opening AG!L2:O" ranges, same upsert-by-
// product+agentCode logic) rather than reimplementing it.
//
// Run with:  npx tsx --env-file=.env.local scripts/reset-and-resync-opening.ts

import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { importAgents } from './migrate-data';

type Product = 'cashout' | 'sendmoney';

async function main() {
  const db = getDb();

  console.log('Resetting agents.opening_balance and agents.sdp to 0 (all products)...');
  const resetResult = await db
    .update(schema.agents)
    .set({ openingBalance: '0', sdp: '0', updatedAt: new Date() })
    .returning({ id: schema.agents.id });
  console.log(`  reset ${resetResult.length} agent rows`);

  for (const product of ['cashout', 'sendmoney'] as Product[]) {
    console.log(`\nRe-syncing ${product} from today's Opening AG sheet...`);
    await importAgents(product);
  }

  const stillZero = await db
    .select({
      product: schema.agents.product,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.agents)
    .where(sql`(opening_balance IS NULL OR opening_balance = 0) AND (sdp IS NULL OR sdp = 0)`)
    .groupBy(schema.agents.product);
  console.log('\nShops still at 0 Opening / 0 SDP after re-sync (not in today\'s sheet, or genuinely 0/0 there):', stillZero);

  const totalByProduct = await db
    .select({ product: schema.agents.product, count: sql<number>`count(*)::int` })
    .from(schema.agents)
    .groupBy(schema.agents.product);
  console.log('Total agent rows per product:', totalByProduct);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
