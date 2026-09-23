import { ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const lines = await db.select().from(schema.openingWalletLines).where(ilike(schema.openingWalletLines.rawAgentName, '%CLINKZ026%'));
  console.log('opening_wallet_lines matching CLINKZ026 (any):', lines);

  const agents = await db.select().from(schema.agents).where(ilike(schema.agents.agentCode, '%CLINKZ%'));
  console.log('\nall CLINKZ agents:', agents.map(a => ({ id: a.id, code: a.agentCode, product: a.product, active: a.isActive, opening: a.openingBalance })));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
