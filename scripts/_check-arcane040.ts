import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { extractSendMoneyShopName, extractShopFamily } from '../app/lib/realShopName';

async function main() {
  const db = getDb();
  const product = 'sendmoney' as const;

  console.log('extractSendMoneyShopName("N-B2PS2-ARCANE040-BK"):', extractSendMoneyShopName('N-B2PS2-ARCANE040-BK'));
  console.log('extractSendMoneyShopName("N-B2PS2-ARCANE040-NG"):', extractSendMoneyShopName('N-B2PS2-ARCANE040-NG'));
  console.log('extractShopFamily("ARCANE040"):', extractShopFamily('ARCANE040'));

  const agentRows = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode, leaderId: schema.agents.leaderId, isActive: schema.agents.isActive, updatedAt: schema.agents.updatedAt })
    .from(schema.agents).where(and(eq(schema.agents.product, product), ilike(schema.agents.agentCode, '%ARCANE040%')));
  console.log('\nagents matching ARCANE040:');
  for (const a of agentRows) {
    const [leader] = a.leaderId ? await db.select().from(schema.leaders).where(eq(schema.leaders.id, a.leaderId)) : [null];
    console.log(' ', a.id, a.agentCode, 'leaderId=', a.leaderId, 'leaderName=', leader?.name, 'active=', a.isActive, a.updatedAt);
    const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, a.id));
    for (const l of lines) console.log('    line:', l.id, l.rawAgentName, l.openingBalance);
  }

  console.log('\nleaders table search for Tempautoplot/Jewel:');
  const leaders = await db.select().from(schema.leaders).where(ilike(schema.leaders.name, '%tempautoplot%'));
  console.log('Tempautoplot leaders:', leaders);
  const jewelLeaders = await db.select().from(schema.leaders).where(ilike(schema.leaders.name, '%jewel%'));
  console.log('Jewel leaders:', jewelLeaders);

  // sibling ARCANE family (other numbers) to see the established family leader
  const familyRows = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode, leaderId: schema.agents.leaderId, isActive: schema.agents.isActive })
    .from(schema.agents).where(and(eq(schema.agents.product, product), ilike(schema.agents.agentCode, 'ARCANE%')));
  console.log('\nARCANE family agents (all):');
  for (const a of familyRows.sort((x,y)=>x.agentCode.localeCompare(y.agentCode))) {
    const [leader] = a.leaderId ? await db.select().from(schema.leaders).where(eq(schema.leaders.id, a.leaderId)) : [null];
    console.log(' ', a.agentCode, 'active=', a.isActive, 'leader=', leader?.name ?? null);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
