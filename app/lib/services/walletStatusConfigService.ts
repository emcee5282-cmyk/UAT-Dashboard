// Server-side Wallet Status Configuration WRITE service.
// Phase 3 of this migration flips NEXT_PUBLIC_WALLET_STATUS_SOURCE_CASHOUT /
// NEXT_PUBLIC_WALLET_STATUS_SOURCE_SENDMONEY — separate per-product flags,
// since the two products cut over independently (Send Money has no roster
// gap blocking it; Cashout is held back pending the 1,479-shadow-agent
// investigation).
//
// Mirrors app/lib/walletStatus.ts's Sheets-based write functions exactly:
//   updateCashoutWalletSettings/updateSendMoneyWalletSettings -> updateWalletSettingsPg
//   the Bulk Edit path                                        -> bulkUpdateWalletSettingsPg
//   updateCashoutWalletStatusField/updateSendMoneyWalletStatusField -> updateWalletStatusFieldPg
//   updateCashoutWalletRemark/updateSendMoneyWalletRemark     -> updateWalletRemarkPg
//
// Same diff-based history convention as transferQueueConfigService.ts
// (transfer_queue_rule_history's own model) — one row per field that
// actually changed, not Sheets' unconditional log-on-every-save.
//
// KEY RESOLUTION — the whole reason Phase 0's schema migration exists.
// Confirmed via real data: of 2,251 real, wallet-linked Cashout agents,
// 1,210 (54%) have 2+ wallets, so Cashout's real row identity is per-WALLET
// (shopKey = "AGENTCODE-BK" etc, matching the live page's own walletCode).
// Send Money's Balance Limit model is "every shop solo" (27 of 11,273
// agents have >1 wallet), so its row identity stays per-SHOP (shopKey =
// bare agentCode). resolveTarget() below is the single place this mapping
// happens — mirrored exactly from app/lib/db/read/walletStatus.ts's own
// key construction (the read-side counterpart), so a shopKey written here
// is always the same key that side already expects to read back.
import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import type {
  Priority, WalletStatusValue, MainReason, ClosureType, AffectedService, ScheduleOverride,
} from '../walletStatus';

const UPDATED_BY = 'Operations Admin';

export type Product = 'cashout' | 'sendmoney';

const WALLET_TYPE_CODE_BY_SUFFIX: Record<string, string> = { BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY' };

// Exported so scripts/migrate-data.ts's importWalletStatus() can reuse the
// exact same key-resolution/upsert logic instead of a second, drift-prone
// copy of it — that duplication is exactly what produced the original bug
// (a flat agentCode lookup that silently mis-keyed 207 of 208 Cashout rows
// to orphaned "shadow" agents, see this file's own header comment).
//
// Typed as just the 3 query-builder methods these helpers actually call
// (not the full transaction type) specifically so BOTH a live request's
// db.transaction() callback AND migrate-data.ts's own plain, non-
// transactional `db` handle satisfy it — Drizzle's full PgTransaction type
// requires transaction-only members (schema/rollback/etc.) a plain db
// handle doesn't have, which a narrower Pick avoids needing to fake.
type FullTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
export type Tx = Pick<FullTx, 'select' | 'insert' | 'update'>;
export type Target = { agentId: number; walletId: number | null };
export type OverridesRow = typeof schema.walletStatusOverrides.$inferSelect;

// Splits Cashout's "AGENTCODE-BK" shopKey into its bare agent code + wallet
// type suffix. Returns suffix: null for a key with no recognizable suffix
// (Send Money keys, or a Cashout wallet whose type never resolved — the
// live page's own walletCode falls back to the bare agentCode in that same
// case, see WALLET_TYPE_ABBREVIATIONS's fallback in app/wallet-status/page.tsx).
// Uppercases throughout — agents.agentCode is consistently stored uppercase
// (confirmed against real data), and the live pages themselves always
// .toUpperCase() their own lookup keys before reading statusData; matching
// that convention here (rather than preserving whatever casing a given
// Sheets row happened to have) avoids a case-mismatch silently missing a
// real agent, the same category of bug this whole migration exists to fix.
function splitCashoutShopKey(shopKey: string): { bareCode: string; suffix: string | null } {
  const upper = shopKey.toUpperCase();
  const match = /^(.*)-(BK|NG|RK|UP)$/.exec(upper);
  if (!match) return { bareCode: upper, suffix: null };
  return { bareCode: upper.slice(0, upper.length - 3), suffix: match[2] };
}

export async function resolveTarget(tx: Tx, product: Product, shopKey: string): Promise<Target> {
  if (product === 'sendmoney') {
    const upper = shopKey.toUpperCase();
    const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents)
      .where(and(eq(schema.agents.product, 'sendmoney'), eq(schema.agents.agentCode, upper)));
    if (!agent) throw new Error(`Agent "${upper}" not found.`);
    return { agentId: agent.id, walletId: null };
  }

  const { bareCode, suffix } = splitCashoutShopKey(shopKey);
  const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents)
    .where(and(eq(schema.agents.product, 'cashout'), eq(schema.agents.agentCode, bareCode)));
  if (!agent) throw new Error(`Agent "${bareCode}" not found.`);

  if (!suffix) return { agentId: agent.id, walletId: null };

  const walletTypeCode = WALLET_TYPE_CODE_BY_SUFFIX[suffix];
  const [wallet] = await tx
    .select({ id: schema.agentWallets.id })
    .from(schema.agentWallets)
    .innerJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(and(eq(schema.agentWallets.agentId, agent.id), eq(schema.walletTypes.code, walletTypeCode)));
  if (!wallet) throw new Error(`Wallet "${shopKey}" not found for agent "${bareCode}".`);

  return { agentId: agent.id, walletId: wallet.id };
}

function targetCondition(target: Target) {
  return target.walletId !== null
    ? eq(schema.walletStatusOverrides.walletId, target.walletId)
    : and(eq(schema.walletStatusOverrides.agentId, target.agentId), isNull(schema.walletStatusOverrides.walletId));
}

export async function selectCurrentRow(tx: Tx, target: Target): Promise<OverridesRow | null> {
  const [row] = await tx.select().from(schema.walletStatusOverrides).where(targetCondition(target));
  return row ?? null;
}

export async function upsertRow(
  tx: Tx,
  target: Target,
  current: OverridesRow | null,
  values: Partial<typeof schema.walletStatusOverrides.$inferInsert>
): Promise<void> {
  if (current) {
    await tx.update(schema.walletStatusOverrides).set(values).where(eq(schema.walletStatusOverrides.id, current.id));
  } else {
    await tx.insert(schema.walletStatusOverrides).values({ agentId: target.agentId, walletId: target.walletId, ...values });
  }
}

type HistoryInsert = typeof schema.walletStatusHistory.$inferInsert;

function makeLogChange(target: Target, updatedAt: Date, historyRows: HistoryInsert[]) {
  return (field: string, oldVal: string, newVal: string) => {
    if (oldVal === newVal) return;
    historyRows.push({ agentId: target.agentId, walletId: target.walletId, fieldName: field, oldValue: oldVal, newValue: newVal, changedBy: UPDATED_BY, changedAt: updatedAt });
  };
}

export type WalletSettingsUpdate = {
  remark: string;
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  minimumAmountCanTake: number | null;
  balanceLimitOverride: number | null;
  scheduleOverride: ScheduleOverride;
};

// Single-wallet save for the unified Edit Wallet Settings modal — mirrors
// updateCashoutWalletSettings/updateSendMoneyWalletSettings. One
// transaction: resolve target, diff every field against the current row,
// log only what changed, upsert.
export async function updateWalletSettingsPg(product: Product, shopKey: string, update: WalletSettingsUpdate): Promise<{ updatedBy: string; updatedAt: string }> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    const target = await resolveTarget(tx, product, shopKey);
    const current = await selectCurrentRow(tx, target);

    const historyRows: HistoryInsert[] = [];
    const logChange = makeLogChange(target, updatedAt, historyRows);

    const currentAffected = (current?.affectedServices ?? []).slice().sort().join(',');
    const currentMinAmt = current?.minimumAmountCanTake === null || current?.minimumAmountCanTake === undefined ? '' : String(current.minimumAmountCanTake);
    const currentBalLimit = current?.balanceLimitOverride === null || current?.balanceLimitOverride === undefined ? '' : String(current.balanceLimitOverride);

    logChange('remark', current?.remark ?? '', update.remark);
    logChange('mainReason', current?.mainReason ?? '', update.mainReason);
    logChange('closureType', current?.closureType ?? '', update.closureType);
    logChange('affectedServices', currentAffected, update.affectedServices.slice().sort().join(','));
    logChange('minimumAmountCanTake', currentMinAmt, update.minimumAmountCanTake === null ? '' : String(update.minimumAmountCanTake));
    logChange('balanceLimitOverride', currentBalLimit, update.balanceLimitOverride === null ? '' : String(update.balanceLimitOverride));
    logChange('scheduleOverride', current?.scheduleOverride ?? '', update.scheduleOverride);

    await upsertRow(tx, target, current, {
      remark: update.remark || null,
      remarkUpdatedBy: UPDATED_BY,
      remarkUpdatedAt: updatedAt,
      mainReason: update.mainReason || null,
      closureType: update.closureType || null,
      affectedServices: update.affectedServices,
      minimumAmountCanTake: update.minimumAmountCanTake === null ? null : String(update.minimumAmountCanTake),
      balanceLimitOverride: update.balanceLimitOverride === null ? null : String(update.balanceLimitOverride),
      scheduleOverride: update.scheduleOverride || null,
    });

    if (historyRows.length > 0) await tx.insert(schema.walletStatusHistory).values(historyRows);
  });

  return { updatedBy: UPDATED_BY, updatedAt: updatedAt.toISOString() };
}

// Cashout-only override fields stay optional here too — undefined means
// "don't touch", distinct from '' / null which are explicit clears. Same
// convention as walletStatus.ts's own WalletStatusBulkUpdate.
export type WalletStatusBulkUpdatePg = {
  shopKey: string;
  priority?: Priority;
  remark?: string;
  mainReason?: MainReason;
  closureType?: ClosureType;
  affectedServices?: AffectedService[];
  minimumAmountCanTake?: number | null;
  balanceLimitOverride?: number | null;
  scheduleOverride?: ScheduleOverride;
};

// Bulk Edit's write path — one transaction covering every selected
// shop/wallet (all-or-nothing), same reasoning as openingActionsService.ts's
// updateOpeningAgents. Each row's own diff/history logging is independent —
// a shop with no real change to a given field never gets a history row
// for it, same as the single-save path above.
export async function bulkUpdateWalletSettingsPg(product: Product, updates: WalletStatusBulkUpdatePg[]): Promise<void> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    for (const entry of updates) {
      const target = await resolveTarget(tx, product, entry.shopKey);
      const current = await selectCurrentRow(tx, target);

      const historyRows: HistoryInsert[] = [];
      const logChange = makeLogChange(target, updatedAt, historyRows);

      const values: Partial<typeof schema.walletStatusOverrides.$inferInsert> = {};

      if (entry.priority !== undefined) {
        logChange('priority', current?.priority ?? 'Normal', entry.priority);
        values.priority = entry.priority;
      }
      if (entry.remark !== undefined) {
        logChange('remark', current?.remark ?? '', entry.remark);
        values.remark = entry.remark || null;
        values.remarkUpdatedBy = UPDATED_BY;
        values.remarkUpdatedAt = updatedAt;
      }
      if (entry.mainReason !== undefined) {
        logChange('mainReason', current?.mainReason ?? '', entry.mainReason);
        values.mainReason = entry.mainReason || null;
      }
      if (entry.closureType !== undefined) {
        logChange('closureType', current?.closureType ?? '', entry.closureType);
        values.closureType = entry.closureType || null;
      }
      if (entry.affectedServices !== undefined) {
        const currentAffected = (current?.affectedServices ?? []).slice().sort().join(',');
        logChange('affectedServices', currentAffected, entry.affectedServices.slice().sort().join(','));
        values.affectedServices = entry.affectedServices;
      }
      if (entry.minimumAmountCanTake !== undefined) {
        const currentMinAmt = current?.minimumAmountCanTake === null || current?.minimumAmountCanTake === undefined ? '' : String(current.minimumAmountCanTake);
        logChange('minimumAmountCanTake', currentMinAmt, entry.minimumAmountCanTake === null ? '' : String(entry.minimumAmountCanTake));
        values.minimumAmountCanTake = entry.minimumAmountCanTake === null ? null : String(entry.minimumAmountCanTake);
      }
      if (entry.balanceLimitOverride !== undefined) {
        const currentBalLimit = current?.balanceLimitOverride === null || current?.balanceLimitOverride === undefined ? '' : String(current.balanceLimitOverride);
        logChange('balanceLimitOverride', currentBalLimit, entry.balanceLimitOverride === null ? '' : String(entry.balanceLimitOverride));
        values.balanceLimitOverride = entry.balanceLimitOverride === null ? null : String(entry.balanceLimitOverride);
      }
      if (entry.scheduleOverride !== undefined) {
        logChange('scheduleOverride', current?.scheduleOverride ?? '', entry.scheduleOverride);
        values.scheduleOverride = entry.scheduleOverride || null;
      }

      if (Object.keys(values).length > 0) await upsertRow(tx, target, current, values);
      if (historyRows.length > 0) await tx.insert(schema.walletStatusHistory).values(historyRows);
    }
  });
}

// Legacy single-field save — mirrors updateCashoutWalletStatusField/
// updateSendMoneyWalletStatusField exactly (still live via
// /api/wallet-status/update, though only 'priority' appears to still be
// called from the current UI — deposit/withdrawal/walletStatus are kept
// for behavioral parity with the Sheets route until confirmed genuinely
// unreachable).
export async function updateWalletStatusFieldPg(
  product: Product,
  shopKey: string,
  field: 'deposit' | 'withdrawal' | 'priority' | 'walletStatus',
  value: string
): Promise<void> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    const target = await resolveTarget(tx, product, shopKey);
    const current = await selectCurrentRow(tx, target);

    const historyRows: HistoryInsert[] = [];
    const logChange = makeLogChange(target, updatedAt, historyRows);

    const values: Partial<typeof schema.walletStatusOverrides.$inferInsert> = {};
    if (field === 'deposit') {
      logChange('deposit', current?.depositEnabled ? 'Yes' : 'No', value);
      values.depositEnabled = value === 'Yes';
    } else if (field === 'withdrawal') {
      logChange('withdrawal', current?.withdrawalEnabled ? 'Yes' : 'No', value);
      values.withdrawalEnabled = value === 'Yes';
    } else if (field === 'priority') {
      logChange('priority', current?.priority ?? 'Normal', value);
      values.priority = value as Priority;
    } else {
      logChange('walletStatus', current?.status ?? '', value);
      values.status = (value || null) as Exclude<WalletStatusValue, ''> | null;
    }

    await upsertRow(tx, target, current, values);
    if (historyRows.length > 0) await tx.insert(schema.walletStatusHistory).values(historyRows);
  });
}

// Standalone remark-only save — mirrors updateCashoutWalletRemark/
// updateSendMoneyWalletRemark. An empty-string remark is a valid,
// intentional value (clearing a remark back out), not skipped.
export async function updateWalletRemarkPg(product: Product, shopKey: string, remark: string): Promise<{ updatedBy: string; updatedAt: string }> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    const target = await resolveTarget(tx, product, shopKey);
    const current = await selectCurrentRow(tx, target);

    const historyRows: HistoryInsert[] = [];
    const logChange = makeLogChange(target, updatedAt, historyRows);
    logChange('remark', current?.remark ?? '', remark);

    await upsertRow(tx, target, current, { remark: remark || null, remarkUpdatedBy: UPDATED_BY, remarkUpdatedAt: updatedAt });
    if (historyRows.length > 0) await tx.insert(schema.walletStatusHistory).values(historyRows);
  });

  return { updatedBy: UPDATED_BY, updatedAt: updatedAt.toISOString() };
}
