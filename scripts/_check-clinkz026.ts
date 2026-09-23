import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  for (const product of ['cashout', 'sendmoney'] as const) {
    const agents = await db.select().from(schema.agents).where(and(eq(schema.agents.product, product), ilike(schema.agents.agentCode, '%CLINKZ026%')));
    console.log(`\n=== ${product} agents matching CLINKZ026 ===`);
    for (const a of agents) {
      console.log(a);
      const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, a.id));
      console.log('  opening_wallet_lines:', lines);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
