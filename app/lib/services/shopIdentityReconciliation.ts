// Opening = single source of truth for shop identity. Balance Limit's own
// auto-create (balanceLimitService.ts) is the one other place that can mint
// a brand-new `agents` row — deliberately kept (real DP/WD activity must
// never be silently dropped just because Opening hasn't mentioned the shop
// yet) — but it resolves shop code independently via extractRealShopName/
// extractSendMoneyShopName, the SAME functions Settlement/TopUp and
// Estimated Balance also use to MATCH (never create) against the roster.
// When that independently-resolved identity doesn't exactly line up with
// what Opening later defines for the same real shop, the app ends up with
// two `agents` rows for one shop — a "ghost" holding real wallet/
// transaction data under raw, unresolved text, and the correct
// Opening-sourced one. Nothing reconciled that gap before this — every fix
// earlier this session (RIAN, PHANTOM008, DRUID004's orphan NAGAD wallet,
// several leader backfills) was this exact problem, fixed by hand, one shop
// at a time.
//
// Own module (not co-located in importService.ts, which is where
// importOpeningFile actually calls this from) because
// openingActionsService.ts's own createOpeningAgent (the manual "Add Shop"
// action) needs this exact same mechanism too — Opening must have exactly
// one identity rule regardless of whether the shop came from bulk import or
// manual creation — and importService.ts already imports FROM
// openingActionsService.ts (resolveOrCreateLeaderId), so importing the
// other direction would be circular.
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { extractRealShopName, extractSendMoneyShopName } from '../realShopName';

export type Product = 'cashout' | 'sendmoney';
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

// A "ghost" for a given bare code X is any OTHER existing agent (same
// product only — never cross-product) whose own agent_code, run back
// through the same extraction function, resolves to X instead of to
// itself — i.e. it is itself still a raw/unresolved identity, not some
// unrelated already-clean shop that coincidentally shares a substring.
// Built once per import (not per row) since it scans the whole roster.
export async function buildGhostAgentMap(db: Tx | ReturnType<typeof getDb>, product: Product): Promise<Map<string, number[]>> {
  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;
  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));

  const map = new Map<string, number[]>();
  for (const a of agentRows) {
    const resolved = extractShopName(a.agentCode);
    if (!resolved || resolved === a.agentCode.trim().toUpperCase()) continue; // already its own clean identity — not a ghost
    if (!map.has(resolved)) map.set(resolved, []);
    map.get(resolved)!.push(a.id);
  }
  return map;
}

// Moves a ghost's real agent_wallets/wallet_transactions onto Opening's own
// canonical target agent for the same shop, then deactivates the ghost.
// Never writes to the target's own `agents` row (agent_code/leader_id/
// opening_balance/sdp/isActive) — those stay entirely owned by Opening's
// existing match/insert logic; this only ever moves data FROM a ghost.
//
// Reassignment (UPDATE), never a copy — after a ghost is fully reconciled
// it has zero agent_wallets/wallet_transactions rows left pointing at it,
// so re-running this against an already-reconciled ghost (e.g. the same
// Opening file re-uploaded, or the same shop added manually twice) naturally
// finds nothing to move and is a safe no-op; no separate "already
// reconciled" flag needed.
//
// agent_wallets moves are per-wallet-type conditional: Balance Limit's own
// import fully deletes and re-inserts a shop's agent_wallets on every
// upload (ephemeral, re-synced data, not historical), so if the target
// already has a wallet of a given type, the ghost's copy is left in place
// rather than overwritten — only a wallet type the target doesn't have yet
// gets moved. wallet_transactions (Settlement/TopUp) are historical
// records, never ephemeral — always moved in full, no type-collision
// concept applies.
export async function reconcileGhostsOntoAgent(tx: Tx, ghostAgentIds: number[], targetAgentId: number): Promise<void> {
  for (const ghostId of ghostAgentIds) {
    if (ghostId === targetAgentId) continue;

    const [targetWallets, ghostWallets] = await Promise.all([
      tx.select({ walletTypeId: schema.agentWallets.walletTypeId }).from(schema.agentWallets).where(eq(schema.agentWallets.agentId, targetAgentId)),
      tx.select({ id: schema.agentWallets.id, walletTypeId: schema.agentWallets.walletTypeId }).from(schema.agentWallets).where(eq(schema.agentWallets.agentId, ghostId)),
    ]);
    const targetHasType = new Set(targetWallets.map((w) => w.walletTypeId).filter((id): id is number => id !== null));
    const movableWalletIds = ghostWallets
      .filter((w) => w.walletTypeId === null || !targetHasType.has(w.walletTypeId))
      .map((w) => w.id);
    if (movableWalletIds.length > 0) {
      await tx.update(schema.agentWallets).set({ agentId: targetAgentId }).where(inArray(schema.agentWallets.id, movableWalletIds));
    }

    await tx.update(schema.walletTransactions).set({ agentId: targetAgentId }).where(eq(schema.walletTransactions.agentId, ghostId));

    await tx.update(schema.agents).set({ isActive: false, updatedAt: new Date() }).where(eq(schema.agents.id, ghostId));
  }
}

const BULK_RECONCILE_CHUNK_SIZE = 500;

// Batched replacement for the reconcileGhostsOntoAgent loop above, built
// for importOpeningFile's bulk path — same guarantees (idempotent,
// product-scoped by construction since ghostToTarget only ever holds pairs
// the caller resolved via a single product-scoped buildGhostAgentMap call,
// never overwrites a target's own agents row or an already-occupied wallet
// type), just executed as a handful of bulk queries instead of ~2 DB round
// trips per ghost PLUS more for every ghost with actual data to move.
// Measured live against a real Cashout Opening upload before this fix:
// 1,616 ghost rows across 967 shops, ~99ms/round-trip to the remote DB —
// ~2.7+ minutes of pure query latency from this step alone. The caller
// collects the whole import's ghost->target pairs in memory during its own
// row loop (free — no extra query, just Map lookups against the one
// buildGhostAgentMap already fetched) and calls this once at the end.
export async function reconcileGhostsForImport(tx: Tx, ghostToTarget: Map<number, number>): Promise<void> {
  const ghostIds = Array.from(ghostToTarget.keys());
  if (ghostIds.length === 0) return;
  const targetIds = Array.from(new Set(ghostToTarget.values()));

  // Bulk-check phase — exactly 2 queries total, no per-ghost looping. The
  // first covers agent_wallets for every ghost AND every target at once
  // (partitioned back apart in JS below by which id set each row's
  // agent_id falls into) — one round trip instead of a separate
  // targetWallets/ghostWallets pair per ghost.
  const allWalletAgentIds = Array.from(new Set([...ghostIds, ...targetIds]));
  const walletRows = await tx
    .select({ id: schema.agentWallets.id, agentId: schema.agentWallets.agentId, walletTypeId: schema.agentWallets.walletTypeId })
    .from(schema.agentWallets)
    .where(inArray(schema.agentWallets.agentId, allWalletAgentIds));

  const ghostIdSet = new Set(ghostIds);
  const targetIdSet = new Set(targetIds);
  const targetWalletTypesByTarget = new Map<number, Set<number>>();
  const ghostWalletRows: { id: number; agentId: number; walletTypeId: number | null }[] = [];
  for (const w of walletRows) {
    if (targetIdSet.has(w.agentId) && w.walletTypeId !== null) {
      if (!targetWalletTypesByTarget.has(w.agentId)) targetWalletTypesByTarget.set(w.agentId, new Set());
      targetWalletTypesByTarget.get(w.agentId)!.add(w.walletTypeId);
    }
    if (ghostIdSet.has(w.agentId)) ghostWalletRows.push({ id: w.id, agentId: w.agentId, walletTypeId: w.walletTypeId });
  }

  const ghostsWithTxnRows = await tx
    .selectDistinct({ agentId: schema.walletTransactions.agentId })
    .from(schema.walletTransactions)
    .where(inArray(schema.walletTransactions.agentId, ghostIds));
  const ghostsWithTxn = new Set(ghostsWithTxnRows.map((r) => r.agentId));

  // Greedy claim, same collision rule as the old per-ghost sequential
  // version: a target's own pre-existing wallet type is never touched, and
  // among several ghosts competing for the same target + type, only the
  // first one claims the slot — the rest stay on their (now-deactivated)
  // ghost. Processed in a stable, deterministic order (wallet row id
  // ascending) rather than the old arbitrary per-row-encounter order —
  // there's no correctness requirement to match that exact tie-break, only
  // that this stays deterministic and idempotent across re-runs of the
  // same file. A null walletTypeId is never a collision target (mirrors
  // the old `=== null` passthrough) — every null-type ghost wallet moves
  // unconditionally.
  const movableWalletMoves: { walletId: number; targetId: number }[] = [];
  const sortedGhostWallets = [...ghostWalletRows].sort((a, b) => a.id - b.id);
  for (const w of sortedGhostWallets) {
    const targetId = ghostToTarget.get(w.agentId)!;
    if (w.walletTypeId === null) {
      movableWalletMoves.push({ walletId: w.id, targetId });
      continue;
    }
    if (!targetWalletTypesByTarget.has(targetId)) targetWalletTypesByTarget.set(targetId, new Set());
    const claimed = targetWalletTypesByTarget.get(targetId)!;
    if (claimed.has(w.walletTypeId)) continue; // already occupied — target's own, or already claimed by an earlier ghost for this same target
    claimed.add(w.walletTypeId);
    movableWalletMoves.push({ walletId: w.id, targetId });
  }

  const txnMoves = ghostIds.filter((id) => ghostsWithTxn.has(id)).map((id) => ({ ghostId: id, targetId: ghostToTarget.get(id)! }));

  // Bulk-write phase — VALUES-join UPDATEs, chunked at 500 rows/statement
  // (same Postgres bound-parameter margin used by bulkUpdateOpeningAgentsWithSdp
  // in importService.ts), instead of one UPDATE per ghost.
  for (let i = 0; i < movableWalletMoves.length; i += BULK_RECONCILE_CHUNK_SIZE) {
    const chunk = movableWalletMoves.slice(i, i + BULK_RECONCILE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const values = sql.join(chunk.map((m) => sql`(${m.walletId}::int, ${m.targetId}::int)`), sql`, `);
    await tx.execute(sql`
      UPDATE agent_wallets AS aw
      SET agent_id = v.target_id
      FROM (VALUES ${values}) AS v(wallet_id, target_id)
      WHERE aw.id = v.wallet_id
    `);
  }

  for (let i = 0; i < txnMoves.length; i += BULK_RECONCILE_CHUNK_SIZE) {
    const chunk = txnMoves.slice(i, i + BULK_RECONCILE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const values = sql.join(chunk.map((m) => sql`(${m.ghostId}::int, ${m.targetId}::int)`), sql`, `);
    await tx.execute(sql`
      UPDATE wallet_transactions AS wt
      SET agent_id = v.target_id
      FROM (VALUES ${values}) AS v(ghost_id, target_id)
      WHERE wt.agent_id = v.ghost_id
    `);
  }

  for (let i = 0; i < ghostIds.length; i += BULK_RECONCILE_CHUNK_SIZE) {
    const chunk = ghostIds.slice(i, i + BULK_RECONCILE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    await tx.update(schema.agents).set({ isActive: false, updatedAt: new Date() }).where(inArray(schema.agents.id, chunk));
  }
}
