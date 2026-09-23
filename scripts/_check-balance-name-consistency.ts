// Confirm Balance page's own Shop Name column already just uses agents.agent_code
// directly (no line-count branching) — same rule Estimated must now follow too.
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const codes = ['AGATE007', 'WAND014', 'DRUID012', 'DRUID022'];
  for (const c of codes) {
    const [a] = await db.select({ agentCode: schema.agents.agentCode }).from(schema.agents).where(eq(schema.agents.agentCode, c));
    console.log(c, '-> agents.agent_code (what Balance page shows as Shop Name):', a?.agentCode);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
