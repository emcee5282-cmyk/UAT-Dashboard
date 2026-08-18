// Phase 7 — Today's Opening row Actions (Edit / Bulk Edit / Delete) against
// PostgreSQL. Same product/table split as openingPageService.ts (read side)
// and importService.ts's importOpeningFile() (upload side) — this is the
// third, mutation-focused piece of that same "Today's Opening" surface, and
// deliberately reuses their conventions rather than inventing new ones:
//   - agents.agent_code is the lookup key (never rewritten by Edit — see
//     updateOpeningAgents' own comment on why).
//   - leader is free text, resolved via find-or-create (mirrors
//     scripts/migrate-data.ts's getOrCreateLeader, reimplemented locally
//     since that script also pulls in Google Sheets fetch helpers this
//     table-only code must never depend on).
//   - brand is a closed set per product (find-only, matching the closed-set
//     combobox both pages' Edit form already presents it as — Edit does not
//     invent new brand codes).
//   - amount fields reuse openingValidation.ts's own checkOptionalAmountField
//     (already the real server-side rule for the same two fields on the
//     upload path) rather than a second, possibly-diverging numeric check.
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { checkOptionalAmountField } from '../openingValidation';
import { parseAmount } from '../format';

export type Product = 'cashout' | 'sendmoney';

export type OpeningFieldUpdates = {
  leader?: string;
  brand?: string;
  openingBalance?: string;
  sdp?: string;
  // Opening's daily-upload Missing Shops review (Phase 3) — the Bulk Import
  // wizard's Mark Inactive/Zero out actions call this same route/function
  // directly (Zero out combines this with openingBalance/sdp = '0').
  isActive?: boolean;
};

export class OpeningActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateAmountField(label: string, value: string): void {
  const result = checkOptionalAmountField(value);
  if (result) throw new OpeningActionError(`${label}: ${result.message}`, 400);
}

// Find-or-create by trimmed name, with an onConflictDoNothing race guard —
// extracted from updateOpeningAgents/createOpeningAgent below, where this
// exact sequence was duplicated. Also reused by importOpeningFile
// (importService.ts) for the daily-upload wizard's "Yes, new shop" insert
// path, so a shop's Leader resolves the same way everywhere it's set.
// Returns null for blank/'-' (matches both original call sites' "no leader"
// convention) — never call this with an empty name expecting a real id back.
export async function resolveOrCreateLeaderId(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  name: string
): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '-') return null;
  const [existing] = await tx.select({ id: schema.leaders.id }).from(schema.leaders).where(eq(schema.leaders.name, trimmed));
  if (existing) return existing.id;
  const [inserted] = await tx.insert(schema.leaders).values({ name: trimmed }).onConflictDoNothing({ target: schema.leaders.name }).returning({ id: schema.leaders.id });
  if (inserted) return inserted.id;
  const [raced] = await tx.select({ id: schema.leaders.id }).from(schema.leaders).where(eq(schema.leaders.name, trimmed));
  return raced?.id ?? null;
}

// Single Edit and Bulk Edit are the SAME operation at different scale — one
// agentCode or many, always one transaction, always all-or-nothing. Per
// explicit instruction: prefer one server-side mutation over a sequence of
// independent per-row calls that could leave a selection half-updated.
export async function updateOpeningAgents(product: Product, agentCodes: string[], updates: OpeningFieldUpdates): Promise<{ updatedCount: number }> {
  if (agentCodes.length === 0) throw new OpeningActionError('No agents specified.', 400);

  if (updates.openingBalance !== undefined) validateAmountField('Opening Balance', updates.openingBalance);
  if (updates.sdp !== undefined) validateAmountField('SDP', updates.sdp);

  const db = getDb();
  let updatedCount = 0;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), inArray(schema.agents.agentCode, agentCodes)));

    const idByCode = new Map(rows.map((r) => [r.agentCode, r.id]));
    const missing = agentCodes.filter((code) => !idByCode.has(code));
    if (missing.length > 0) {
      throw new OpeningActionError(`Agent(s) not found, no changes were made: ${missing.join(', ')}`, 404);
    }

    const leaderId: number | null | undefined = updates.leader !== undefined
      ? await resolveOrCreateLeaderId(tx, updates.leader)
      : undefined;

    // Brand is find-ONLY (no create) — both pages' Edit form presents Brand
    // as a closed-set combobox (allowCustom not set), so a value reaching
    // here that isn't already a real row for this product is a genuine
    // input error, not a new brand to register.
    let brandId: number | null | undefined;
    if (updates.brand !== undefined) {
      const trimmed = updates.brand.trim().toUpperCase();
      if (!trimmed || trimmed === '-') {
        brandId = null;
      } else {
        const [existing] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.product, product), eq(schema.brands.code, trimmed)));
        if (!existing) throw new OpeningActionError(`"${updates.brand}" is not a recognized brand for this product.`, 400);
        brandId = existing.id;
      }
    }
    // A blank amount field means "clear it" — writes the column's true
    // nullable state rather than inventing a 0. Cashout's own display layer
    // already coerces null to 0 (see openingPageService.ts), so this is
    // invisible there; Send Money's display keeps the real null, correctly.
    const openingBalance = updates.openingBalance !== undefined
      ? (updates.openingBalance.trim() === '' ? null : parseAmount(updates.openingBalance).toFixed(2))
      : undefined;
    const sdp = updates.sdp !== undefined
      ? (updates.sdp.trim() === '' ? null : parseAmount(updates.sdp).toFixed(2))
      : undefined;

    const setValues: Partial<typeof schema.agents.$inferInsert> = { updatedAt: new Date() };
    if (leaderId !== undefined) setValues.leaderId = leaderId;
    if (brandId !== undefined) setValues.brandId = brandId;
    if (openingBalance !== undefined) setValues.openingBalance = openingBalance;
    if (sdp !== undefined) setValues.sdp = sdp;
    if (updates.isActive !== undefined) setValues.isActive = updates.isActive;

    const ids = agentCodes.map((code) => idByCode.get(code)!);
    await tx.update(schema.agents).set(setValues).where(inArray(schema.agents.id, ids));
    updatedCount = ids.length;
  });

  return { updatedCount };
}

export type NewOpeningAgent = {
  agentCode: string;
  leader?: string;
  brand?: string;
  openingBalance?: string;
  sdp?: string;
};

// "New Account" — the create side of the same Today's Opening surface.
// Deliberately a real INSERT, never an upsert: creating an agentCode that
// already exists for this product is a genuine input error (the roster
// already has that shop), not a silent overwrite of its Edit history —
// caught inside the same transaction as the insert to avoid a race between
// the pre-check and the write.
export async function createOpeningAgent(product: Product, input: NewOpeningAgent): Promise<{ agentCode: string }> {
  const agentCode = input.agentCode.trim();
  if (!agentCode) throw new OpeningActionError('Agent Name is required.', 400);

  if (input.openingBalance !== undefined) validateAmountField('Opening Balance', input.openingBalance);
  if (input.sdp !== undefined) validateAmountField('SDP', input.sdp);

  const db = getDb();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), eq(schema.agents.agentCode, agentCode)));
    if (existing) throw new OpeningActionError(`"${agentCode}" already exists for this product.`, 409);

    const leaderId = await resolveOrCreateLeaderId(tx, input.leader ?? '');

    let brandId: number | null = null;
    const brandCode = (input.brand ?? '').trim().toUpperCase();
    if (brandCode && brandCode !== '-') {
      const [existingBrand] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.product, product), eq(schema.brands.code, brandCode)));
      if (!existingBrand) throw new OpeningActionError(`"${input.brand}" is not a recognized brand for this product.`, 400);
      brandId = existingBrand.id;
    }

    const openingBalance = input.openingBalance !== undefined && input.openingBalance.trim() !== '' ? parseAmount(input.openingBalance).toFixed(2) : null;
    const sdp = input.sdp !== undefined && input.sdp.trim() !== '' ? parseAmount(input.sdp).toFixed(2) : null;

    await tx.insert(schema.agents).values({
      product,
      agentCode,
      leaderId,
      brandId,
      openingBalance,
      sdp,
      updatedAt: new Date(),
    });
  });

  return { agentCode };
}

export type DeleteBlockedReason = { table: string; count: number };

// Hard-delete only when nothing references this agent. No cascade is ever
// invented here — agents.id is a real FK target for agent_wallets,
// wallet_transactions (the historical ledger), wallet_status_overrides,
// estimated_balance_entries, and transfer_queue_linked_accounts, none of
// which have an ON DELETE rule in the schema, so an unchecked DELETE would
// either fail on a raw FK-violation (opaque to the caller) or, if a cascade
// were added, silently destroy transaction history — neither acceptable
// without an explicit product decision. Checking first turns that into a
// clear, safe, listed reason instead.
export async function deleteOpeningAgent(product: Product, agentCode: string): Promise<{ deleted: true }> {
  const db = getDb();

  await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), eq(schema.agents.agentCode, agentCode)));
    if (!agent) throw new OpeningActionError(`Agent "${agentCode}" not found.`, 404);

    const [wallets] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.agentWallets).where(eq(schema.agentWallets.agentId, agent.id));
    const [txns] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.walletTransactions).where(eq(schema.walletTransactions.agentId, agent.id));
    const [statusOverride] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.walletStatusOverrides).where(eq(schema.walletStatusOverrides.agentId, agent.id));
    const [estEntries] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.estimatedBalanceEntries).where(eq(schema.estimatedBalanceEntries.agentId, agent.id));
    const [linkedAccounts] = await tx.select({ c: sql<number>`count(*)::int` }).from(schema.transferQueueLinkedAccounts).where(eq(schema.transferQueueLinkedAccounts.cashoutAgentId, agent.id));

    const blocked: DeleteBlockedReason[] = [
      { table: 'wallet record(s)', count: wallets.c },
      { table: 'transaction record(s)', count: txns.c },
      { table: 'wallet status override(s)', count: statusOverride.c },
      { table: 'estimated opening entrie(s)', count: estEntries.c },
      { table: 'transfer queue linked account(s)', count: linkedAccounts.c },
    ].filter((r) => r.count > 0);

    if (blocked.length > 0) {
      const detail = blocked.map((r) => `${r.count} ${r.table}`).join(', ');
      throw new OpeningActionError(`Cannot delete "${agentCode}": referenced by ${detail}. Remove or reassign these first.`, 409);
    }

    await tx.delete(schema.agents).where(eq(schema.agents.id, agent.id));
  });

  return { deleted: true };
}
