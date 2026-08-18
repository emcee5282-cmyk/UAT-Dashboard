// Server-side Transfer Queue Configuration WRITE service — LOCAL/FOUNDATION
// ONLY, not wired into any existing page or route. Wiring the admin
// Settings UI (app/settings/page.tsx) to this is Phase 4, a separate step —
// this phase only builds and verifies the write path itself.
//
// Mirrors app/lib/transferQueueSettings.ts's own Sheets-based write
// functions (updateTransferQueueRule/updateBundleField/setTransferQueueMode)
// exactly:
//   - Same "log only fields that actually changed" history convention.
//     Confirmed by reconciling all 37 real Sheets history entries against
//     Postgres's 20: the 17 "missing" ones are all genuine no-op resaves
//     (old === new on every one of operator/value1/value2/queueResult) —
//     Sheets logs unconditionally on every Save call, but a diff-based
//     model correctly never wrote these and still shouldn't. Nothing to
//     backfill.
//   - Same no-history-for-Bundle/Mode changes — Sheets' own
//     updateBundleField()/setTransferQueueMode() never call
//     appendRuleHistory either (confirmed by reading both functions in
//     full); history is rule-value changes only, by design, not an
//     oversight this migration should "fix".
//   - Same version-bump-on-save for rule/bundle changes; Mode changes do
//     NOT bump version in the Sheets original either (setTransferQueueMode
//     writes the Mode field's own updatedAt but never calls bumpVersion) —
//     preserved here exactly.
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import type { Operator } from '../transferQueueRules';

// No auth system exists in this app — same static label convention as
// every other write path (transferQueueSettings.ts's own UPDATED_BY,
// estimatedOpening.ts's IMPORTED_BY, walletStatus.ts's REMARK_UPDATED_BY).
const UPDATED_BY = 'Operations Admin';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function bumpVersion(tx: Tx, updatedAt: Date): Promise<void> {
  await tx
    .update(schema.transferQueueMetaConfig)
    .set({ version: sql`${schema.transferQueueMetaConfig.version} + 1`, updatedBy: UPDATED_BY, updatedAt });
}

export type TransferQueueRuleUpdate = {
  operator: Operator;
  value1: number;
  value2: number | null;
  queueResult: string;
  enabled: boolean;
};

// Updates exactly one rule row by id, diffing against its current stored
// state field-by-field so only genuinely-changed fields produce a history
// row (see header comment) — mirrors updateTransferQueueRule's own
// "read current state BEFORE overwriting, so history captures a real
// previous value" ordering.
export async function updateTransferQueueRulePg(id: number, updates: TransferQueueRuleUpdate): Promise<{ updatedBy: string; updatedAt: string }> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.transferQueueRules).where(eq(schema.transferQueueRules.id, id));
    if (!current) throw new Error(`Transfer Queue rule ${id} not found.`);

    const currentValue1 = current.value1 === null ? null : Number(current.value1);
    const currentValue2 = current.value2 === null ? null : Number(current.value2);

    type HistoryInsert = typeof schema.transferQueueRuleHistory.$inferInsert;
    const historyRows: HistoryInsert[] = [];
    const logChange = (field: string, oldVal: string, newVal: string) => {
      if (oldVal === newVal) return;
      historyRows.push({ ruleId: id, changedField: field, oldValue: oldVal, newValue: newVal, changedBy: UPDATED_BY, changedAt: updatedAt });
    };
    logChange('operator', current.operator, updates.operator);
    logChange('value1', currentValue1 === null ? '' : String(currentValue1), String(updates.value1));
    logChange('value2', currentValue2 === null ? '' : String(currentValue2), updates.value2 === null ? '' : String(updates.value2));
    logChange('queueResult', current.queueResult ?? '', updates.queueResult);
    // Sheets' own history model never logs Enabled changes (RuleHistoryEntry
    // has no oldEnabled/newEnabled field at all — confirmed by reading its
    // type definition) — preserved here, not silently expanded.

    await tx
      .update(schema.transferQueueRules)
      .set({
        operator: updates.operator,
        value1: String(updates.value1),
        value2: updates.value2 === null ? null : String(updates.value2),
        queueResult: updates.queueResult,
        enabled: updates.enabled,
        updatedBy: UPDATED_BY,
        updatedAt,
      })
      .where(eq(schema.transferQueueRules.id, id));

    if (historyRows.length > 0) {
      await tx.insert(schema.transferQueueRuleHistory).values(historyRows);
    }

    await bumpVersion(tx, updatedAt);
  });

  return { updatedBy: UPDATED_BY, updatedAt: updatedAt.toISOString() };
}

export async function updateBundleFieldPg(fieldName: string, value: string): Promise<{ updatedBy: string; updatedAt: string }> {
  const db = getDb();
  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: schema.transferQueueBundleSettings.id }).from(schema.transferQueueBundleSettings).where(eq(schema.transferQueueBundleSettings.fieldName, fieldName));
    if (!existing) throw new Error(`Bundle field "${fieldName}" not found.`);

    await tx
      .update(schema.transferQueueBundleSettings)
      .set({ fieldValue: value })
      .where(eq(schema.transferQueueBundleSettings.fieldName, fieldName));

    await bumpVersion(tx, updatedAt);
  });

  return { updatedBy: UPDATED_BY, updatedAt: updatedAt.toISOString() };
}

export type TransferQueueMode = 'production' | 'configuration';

// Does NOT bump version — matches setTransferQueueMode()'s own Sheets
// behavior exactly (it writes the Mode field's own updatedAt but never
// calls bumpVersion; only rule/bundle saves do).
export async function setTransferQueueModePg(mode: TransferQueueMode): Promise<{ updatedBy: string; updatedAt: string }> {
  const db = getDb();
  const updatedAt = new Date();

  await db.update(schema.transferQueueMetaConfig).set({ mode, updatedBy: UPDATED_BY, updatedAt });

  return { updatedBy: UPDATED_BY, updatedAt: updatedAt.toISOString() };
}
