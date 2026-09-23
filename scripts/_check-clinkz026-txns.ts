import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const txns = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.agentId, 88018));
  console.log('wallet_transactions for CLINKZ026 (id=88018):', txns);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
