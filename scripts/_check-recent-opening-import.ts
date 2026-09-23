// Check whether a real Opening import has run since the batched
// reconciliation fix landed, and look for obvious signs of trouble
// (agents deactivated unexpectedly, duplicate wallet types under one
// agent, etc).
// Run with: npx tsx --env-file=.env.local scripts/_check-recent-opening-import.ts
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();

  const recentBatches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.importType, 'opening'))
    .orderBy(desc(schema.importBatches.startedAt))
    .limit(5);
  console.log('Recent Opening import batches:');
  for (const b of recentBatches) {
    console.log(' ', b.id, b.product, b.status, b.startedAt, b.completedAt, 'rowCount=', b.rowCount);
  }

  // Agents deactivated most recently (candidates for "reconciled as a ghost
  // just now") — top 20 by updatedAt.
  const recentlyDeactivated = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, product: schema.agents.product, updatedAt: schema.agents.updatedAt })
    .from(schema.agents)
    .where(eq(schema.agents.isActive, false))
    .orderBy(desc(schema.agents.updatedAt))
    .limit(20);
  console.log('\nMost recently deactivated agents:');
  for (const a of recentlyDeactivated) console.log(' ', a.id, a.agentCode, a.product, a.updatedAt);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
