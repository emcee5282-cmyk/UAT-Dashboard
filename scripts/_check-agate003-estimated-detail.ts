import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const product = 'cashout' as const;

  const [lastUpload] = await db.select().from(schema.estimatedBalanceUploads)
    .where(eq(schema.estimatedBalanceUploads.product, product))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt)).limit(1);
  console.log('lastUpload:', lastUpload);

  const [agent] = await db.select().from(schema.agents).where(and(eq(schema.agents.product, product), eq(schema.agents.agentCode, 'AGATE003')));
  console.log('agent:', agent);

  const entryRows = await db.select().from(schema.estimatedBalanceEntries)
    .where(and(eq(schema.estimatedBalanceEntries.uploadId, lastUpload.id), eq(schema.estimatedBalanceEntries.agentId, agent.id)));
  console.log('estimated_balance_entries:', entryRows);

  const walletLineRows = await db.select().from(schema.estimatedBalanceWalletLines)
    .where(and(eq(schema.estimatedBalanceWalletLines.uploadId, lastUpload.id), eq(schema.estimatedBalanceWalletLines.agentId, agent.id)));
  console.log('estimated_balance_wallet_lines:', walletLineRows);

  const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, agent.id));
  console.log('opening_wallet_lines (CURRENT):', lines);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
