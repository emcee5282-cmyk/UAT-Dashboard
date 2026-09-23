// Read-only verification for backfill-settlement-topup-cashgo.ts's results.
// Run with: npx tsx --env-file=.env.local scripts/verify-backfill.ts
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();

  const wt = await db
    .select({
      product: schema.walletTransactions.product,
      transactionType: schema.walletTransactions.transactionType,
      count: sql<number>`count(*)::int`,
      minDate: sql<string>`min(occurred_on)::text`,
      maxDate: sql<string>`max(occurred_on)::text`,
    })
    .from(schema.walletTransactions)
    .groupBy(schema.walletTransactions.product, schema.walletTransactions.transactionType);
  console.log('wallet_transactions:', wt);

  const cg = await db
    .select({
      count: sql<number>`count(*)::int`,
      minDate: sql<string>`min(business_date)::text`,
      maxDate: sql<string>`max(business_date)::text`,
    })
    .from(schema.dailyTxnCashgoEntry);
  console.log('daily_txn_cashgo_entry:', cg);

  const cgSample = await db
    .select()
    .from(schema.dailyTxnCashgoEntry)
    .orderBy(sql`business_date desc`)
    .limit(6);
  console.log('daily_txn_cashgo_entry (latest 6 rows):', cgSample);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
