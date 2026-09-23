import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const [lastUpload] = await db.select().from(schema.estimatedBalanceUploads)
    .where(eq(schema.estimatedBalanceUploads.product, 'sendmoney'))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt)).limit(1);
  console.log('Last sendmoney upload:', lastUpload);

  const walletTotalsRows = await db.select().from(schema.estimatedBalanceWalletTotals)
    .where(eq(schema.estimatedBalanceWalletTotals.uploadId, lastUpload.id));
  console.log('estimated_balance_wallet_totals rows for this upload:', walletTotalsRows);

  const entriesCount = await db.select({ id: schema.estimatedBalanceEntries.id }).from(schema.estimatedBalanceEntries)
    .where(eq(schema.estimatedBalanceEntries.uploadId, lastUpload.id));
  console.log('estimated_balance_entries row count:', entriesCount.length);

  const walletLinesCount = await db.select({ id: schema.estimatedBalanceWalletLines.id }).from(schema.estimatedBalanceWalletLines)
    .where(eq(schema.estimatedBalanceWalletLines.uploadId, lastUpload.id));
  console.log('estimated_balance_wallet_lines row count:', walletLinesCount.length);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
