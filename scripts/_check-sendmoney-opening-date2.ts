import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const rows = await db.select().from(schema.dailyTxnWalletClosingEntry)
    .where(eq(schema.dailyTxnWalletClosingEntry.ledgerId, 'ssp2'))
    .orderBy(desc(schema.dailyTxnWalletClosingEntry.businessDate))
    .limit(8);
  console.log(rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
