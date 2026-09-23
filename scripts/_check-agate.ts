import { eq, ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { readEstimatedOpeningDisplayPg } from '../app/lib/db/read/estimatedOpening';

async function main() {
  const db = getDb();

  const result = await readEstimatedOpeningDisplayPg('cashout');
  console.log('--- shopRows AGATE ---');
  for (const r of result.shopRows) {
    if (r.agentCode.toUpperCase().includes('AGATE') || r.displayName.toUpperCase().includes('AGATE')) {
      console.log(' ', JSON.stringify(r));
    }
  }
  console.log('\n--- walletRows AGATE ---');
  for (const r of result.walletRows) {
    if (r.agentCode.toUpperCase().includes('AGATE') || r.shopDisplayName.toUpperCase().includes('AGATE') || r.walletDisplayName.toUpperCase().includes('AGATE')) {
      console.log(' ', JSON.stringify(r));
    }
  }

  console.log('\n--- all agents with AGATE in code ---');
  const agentRows = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive, updatedAt: schema.agents.updatedAt })
    .from(schema.agents).where(ilike(schema.agents.agentCode, '%AGATE%'));
  for (const a of agentRows.sort((x,y)=>x.agentCode.localeCompare(y.agentCode))) console.log(' ', a.id, a.agentCode, 'active=',a.isActive, a.updatedAt);

  console.log('\n--- opening_wallet_lines for each active AGATE agent ---');
  for (const a of agentRows.filter(a=>a.isActive)) {
    const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, a.id));
    console.log(` agentId=${a.id} (${a.agentCode}):`, lines.map(l => ({ id: l.id, raw: l.rawAgentName, opening: l.openingBalance })));
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
