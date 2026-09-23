// Full-scale timing check: build the REAL, full-size ghost->target map for
// a Cashout Opening import (~967 groups / ~1,616 ghosts) using only
// in-memory lookups (mirrors what importOpeningFile's row loop already has
// for free — no extra queries), then time ONLY reconcileGhostsForImport
// itself, inside a transaction that's rolled back at the end (never
// committed). This isolates the reconciliation step's own cost, matching
// how it's actually invoked in production.
// Run with: npx tsx --env-file=.env.local scripts/_time-batched-reconcile-full.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { buildGhostAgentMap, reconcileGhostsForImport } from '../app/lib/services/shopIdentityReconciliation';

const ROLLBACK_SENTINEL = new Error('__ROLLBACK_SENTINEL__');

async function main() {
  const db = getDb();

  console.time('buildGhostAgentMap');
  const ghostMap = await buildGhostAgentMap(db, 'cashout');
  console.timeEnd('buildGhostAgentMap');

  console.time('fetch roster (for in-memory target lookup, same as importOpeningFile already does)');
  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, 'cashout'));
  const targetIdByCode = new Map<string, number>();
  for (const a of agentRows) targetIdByCode.set(a.agentCode.trim().toUpperCase(), a.id);
  console.timeEnd('fetch roster (for in-memory target lookup, same as importOpeningFile already does)');

  const ghostToTarget = new Map<number, number>();
  let groupsWithNoTarget = 0;
  for (const [resolvedCode, ghostIds] of ghostMap) {
    const targetId = targetIdByCode.get(resolvedCode);
    if (targetId === undefined) { groupsWithNoTarget++; continue; }
    for (const gid of ghostIds) {
      if (gid !== targetId) ghostToTarget.set(gid, targetId);
    }
  }
  console.log(`Full ghost->target map: ${ghostToTarget.size} ghosts (groups with no current target: ${groupsWithNoTarget}, i.e. shop not in Opening yet — same as production skips these).`);

  try {
    await db.transaction(async (tx) => {
      console.time('reconcileGhostsForImport (FULL SCALE, batched)');
      await reconcileGhostsForImport(tx, ghostToTarget);
      console.timeEnd('reconcileGhostsForImport (FULL SCALE, batched)');
      throw ROLLBACK_SENTINEL;
    });
  } catch (e) {
    if (e !== ROLLBACK_SENTINEL) throw e;
  }
  console.log('Rolled back — no data changed.');

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
