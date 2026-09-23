// Investigate: Send Money Opening upload reportedly taking 5+ minutes.
// Check recent import_batches (stuck/slow?), roster size, and ghost count
// for sendmoney specifically.
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { buildGhostAgentMap, reconcileGhostsForImport } from '../app/lib/services/shopIdentityReconciliation';

const ROLLBACK_SENTINEL = new Error('__ROLLBACK__');

async function main() {
  const db = getDb();
  const product = 'sendmoney' as const;

  const recentBatches = await db
    .select()
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.product, product), eq(schema.importBatches.importType, 'opening')))
    .orderBy(desc(schema.importBatches.startedAt))
    .limit(5);
  console.log('Recent Send Money Opening import batches:');
  for (const b of recentBatches) {
    const durationMs = b.completedAt && b.startedAt ? b.completedAt.getTime() - b.startedAt.getTime() : null;
    console.log(' ', b.id, b.status, 'started=', b.startedAt, 'completed=', b.completedAt, durationMs ? `duration=${(durationMs/1000).toFixed(1)}s` : '(still running / no completedAt)', 'rowCount=', b.rowCount);
  }

  const [rosterCount] = await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));
  const allRoster = await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));
  console.log('\nActive sendmoney roster size:', allRoster.length);

  const allRosterAny = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.product, product));
  console.log('Total sendmoney agents (any isActive):', allRosterAny.length);

  console.time('buildGhostAgentMap (sendmoney)');
  const ghostMap = await buildGhostAgentMap(db, product);
  console.timeEnd('buildGhostAgentMap (sendmoney)');

  let groups = 0, totalGhosts = 0, multiGhostGroups = 0;
  for (const [, ids] of ghostMap) {
    groups++;
    totalGhosts += ids.length;
    if (ids.length > 1) multiGhostGroups++;
  }
  console.log(`Resolved-code groups with >=1 ghost: ${groups} (multi-ghost: ${multiGhostGroups}), total ghost rows: ${totalGhosts}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
