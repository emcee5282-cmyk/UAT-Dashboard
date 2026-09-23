// Diagnostic: quantify how much the shopIdentityReconciliation step
// (added this session, wired into importOpeningFile) adds to a real
// Opening upload — the user reports uploads got much slower recently.
// Measures: (1) how many rows in a typical import would trigger
// reconcileGhostsOntoAgent, (2) real round-trip latency of its queries
// against the live remote Postgres DB, to extrapolate total added time.
// Run with: npx tsx --env-file=.env.local scripts/_check-import-perf.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { buildGhostAgentMap } from '../app/lib/services/shopIdentityReconciliation';

async function main() {
  const db = getDb();

  console.time('buildGhostAgentMap (cashout)');
  const ghostMap = await buildGhostAgentMap(db, 'cashout');
  console.timeEnd('buildGhostAgentMap (cashout)');

  let groups = 0;
  let totalGhosts = 0;
  let multiGhostGroups = 0;
  for (const [, ids] of ghostMap) {
    groups++;
    totalGhosts += ids.length;
    if (ids.length > 1) multiGhostGroups++;
  }
  console.log(`Resolved-code groups with >=1 ghost: ${groups}`);
  console.log(`  of which multi-ghost: ${multiGhostGroups}`);
  console.log(`Total ghost agent rows: ${totalGhosts}`);

  // Sample real round-trip latency for the two SELECTs reconcileGhostsOntoAgent
  // runs per ghost (targetWallets + ghostWallets), against a handful of real
  // agent ids, to get an honest per-ghost cost estimate.
  const [sampleAgent] = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.product, 'cashout')).limit(1);
  const N = 20;
  console.time(`${N}x sequential (targetWallets+ghostWallets) query pairs`);
  for (let i = 0; i < N; i++) {
    await Promise.all([
      db.select({ walletTypeId: schema.agentWallets.walletTypeId }).from(schema.agentWallets).where(eq(schema.agentWallets.agentId, sampleAgent.id)),
      db.select({ id: schema.agentWallets.id, walletTypeId: schema.agentWallets.walletTypeId }).from(schema.agentWallets).where(eq(schema.agentWallets.agentId, sampleAgent.id)),
    ]);
  }
  console.timeEnd(`${N}x sequential (targetWallets+ghostWallets) query pairs`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
