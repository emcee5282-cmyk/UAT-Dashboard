// Correctness check: run the OLD per-ghost sequential reconciliation and
// the NEW batched one against the SAME real sample of ghost/target pairs,
// each inside its own transaction that gets rolled back (never committed),
// and diff the resulting agent_wallets/wallet_transactions/agents state.
// Run with: npx tsx --env-file=.env.local scripts/_verify-batched-reconcile.ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { buildGhostAgentMap, reconcileGhostsOntoAgent, reconcileGhostsForImport } from '../app/lib/services/shopIdentityReconciliation';

const ROLLBACK_SENTINEL = new Error('__ROLLBACK_SENTINEL__');

type Snapshot = {
  walletOwners: Record<number, number>; // wallet row id -> agent_id
  txnOwners: Record<number, number>; // txn row id -> agent_id
  ghostActive: Record<number, boolean>; // ghost agent id -> isActive
};

async function captureSnapshot(tx: any, ghostToTarget: Map<number, number>): Promise<Snapshot> {
  const ghostIds = Array.from(ghostToTarget.keys());
  const targetIds = Array.from(new Set(ghostToTarget.values()));
  const allIds = Array.from(new Set([...ghostIds, ...targetIds]));

  const wallets = await tx
    .select({ id: schema.agentWallets.id, agentId: schema.agentWallets.agentId })
    .from(schema.agentWallets)
    .where(inArray(schema.agentWallets.agentId, allIds));
  const txns = await tx
    .select({ id: schema.walletTransactions.id, agentId: schema.walletTransactions.agentId })
    .from(schema.walletTransactions)
    .where(inArray(schema.walletTransactions.agentId, allIds));
  const agentsRows = await tx
    .select({ id: schema.agents.id, isActive: schema.agents.isActive })
    .from(schema.agents)
    .where(inArray(schema.agents.id, ghostIds));

  const walletOwners: Record<number, number> = {};
  for (const w of wallets) walletOwners[w.id] = w.agentId;
  const txnOwners: Record<number, number> = {};
  for (const t of txns) txnOwners[t.id] = t.agentId;
  const ghostActive: Record<number, boolean> = {};
  for (const a of agentsRows) ghostActive[a.id] = a.isActive;

  return { walletOwners, txnOwners, ghostActive };
}

async function main() {
  const db = getDb();

  const ghostMap = await buildGhostAgentMap(db, 'cashout');

  // Build a real ghostToTarget sample: for each resolved code, find the
  // clean agent whose own agentCode exactly equals it (case-insensitive) —
  // that's the real target importOpeningFile would resolve to for a row
  // with that Agent Name. Skip codes with no such agent currently (shop
  // not yet in Opening — not reconcilable either way). Cap the sample so
  // this stays fast; prioritize multi-ghost groups since those exercise
  // the wallet-type-collision logic the hardest.
  const entries = Array.from(ghostMap.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 150);
  const ghostToTarget = new Map<number, number>();
  for (const [resolvedCode, ghostIds] of entries) {
    const [target] = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, 'cashout'), sql`upper(trim(${schema.agents.agentCode})) = ${resolvedCode}`))
      .limit(1);
    if (!target) continue;
    for (const gid of ghostIds) {
      if (gid !== target.id) ghostToTarget.set(gid, target.id);
    }
  }
  console.log(`Sample: ${ghostToTarget.size} ghost->target pairs across up to 150 groups.`);

  // --- Run 1: OLD per-ghost sequential logic, grouped back by target ---
  const byTarget = new Map<number, number[]>();
  for (const [ghostId, targetId] of ghostToTarget) {
    if (!byTarget.has(targetId)) byTarget.set(targetId, []);
    byTarget.get(targetId)!.push(ghostId);
  }

  let oldSnapshot: Snapshot | null = null;
  try {
    await db.transaction(async (tx) => {
      for (const [targetId, ghostIds] of byTarget) {
        await reconcileGhostsOntoAgent(tx, ghostIds, targetId);
      }
      oldSnapshot = await captureSnapshot(tx, ghostToTarget);
      throw ROLLBACK_SENTINEL;
    });
  } catch (e) {
    if (e !== ROLLBACK_SENTINEL) throw e;
  }
  console.log('OLD run captured + rolled back.');

  // --- Run 2: NEW batched logic ---
  let newSnapshot: Snapshot | null = null;
  try {
    await db.transaction(async (tx) => {
      await reconcileGhostsForImport(tx, ghostToTarget);
      newSnapshot = await captureSnapshot(tx, ghostToTarget);
      throw ROLLBACK_SENTINEL;
    });
  } catch (e) {
    if (e !== ROLLBACK_SENTINEL) throw e;
  }
  console.log('NEW run captured + rolled back.');

  // --- Diff ---
  const a = oldSnapshot!;
  const b = newSnapshot!;
  let mismatches = 0;

  const allWalletIds = new Set([...Object.keys(a.walletOwners), ...Object.keys(b.walletOwners)]);
  for (const id of allWalletIds) {
    if (a.walletOwners[id as any] !== b.walletOwners[id as any]) {
      mismatches++;
      console.log(`  WALLET MISMATCH id=${id}: old=${a.walletOwners[id as any]} new=${b.walletOwners[id as any]}`);
    }
  }
  const allTxnIds = new Set([...Object.keys(a.txnOwners), ...Object.keys(b.txnOwners)]);
  for (const id of allTxnIds) {
    if (a.txnOwners[id as any] !== b.txnOwners[id as any]) {
      mismatches++;
      console.log(`  TXN MISMATCH id=${id}: old=${a.txnOwners[id as any]} new=${b.txnOwners[id as any]}`);
    }
  }
  const allGhostIds = new Set([...Object.keys(a.ghostActive), ...Object.keys(b.ghostActive)]);
  for (const id of allGhostIds) {
    if (a.ghostActive[id as any] !== b.ghostActive[id as any]) {
      mismatches++;
      console.log(`  GHOST-ACTIVE MISMATCH id=${id}: old=${a.ghostActive[id as any]} new=${b.ghostActive[id as any]}`);
    }
  }

  console.log(`\nWallet rows compared: ${allWalletIds.size}`);
  console.log(`Txn rows compared:    ${allTxnIds.size}`);
  console.log(`Ghost agents compared: ${allGhostIds.size}`);
  console.log(mismatches === 0 ? '\nMATCH: identical result between old and new logic.' : `\n${mismatches} MISMATCHES found.`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
