import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.agentCode, 'WAND014'));
  console.log('agents WAND014 (exact):', agentRows);

  for (const a of agentRows) {
    const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, a.id));
    console.log(`opening_wallet_lines for agentId=${a.id} (${a.agentCode}, active=${a.isActive}):`, lines);
  }

  // Also check for any OTHER agent whose code is 'WAND014BK' or similar
  const likeRows = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive })
    .from(schema.agents);
  const wand014Variants = likeRows.filter(r => r.agentCode.toUpperCase().includes('WAND014'));
  console.log('\nAll agents with WAND014 in code:', wand014Variants);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
