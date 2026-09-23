// Follow-up: list every existing agent whose code starts with these
// prefixes, to see whether the missing numbers (012/013, 011/012, 048-058,
// 010/012, 002) are gaps in an otherwise-populated family or genuinely
// brand-new shops Opening has never had at all.
// Run with: npx tsx --env-file=.env.local scripts/_check-missing-estimated-4.ts
import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const PREFIXES = ['KAIDO', 'DOGG', 'NICO', 'SANJI', 'CLAW'];

async function main() {
  const db = getDb();
  for (const p of PREFIXES) {
    const rows = await db
      .select({ agentCode: schema.agents.agentCode, isActive: schema.agents.isActive })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, 'cashout'), ilike(schema.agents.agentCode, `${p}%`)));
    console.log(`\n${p}* (${rows.length}):`, rows.map((r) => `${r.agentCode}${r.isActive ? '' : '(inactive)'}`).sort());
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
