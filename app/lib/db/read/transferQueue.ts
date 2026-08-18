// PostgreSQL read-layer mirror of Transfer Queue Settings reads
// (readTransferQueueRules / readBundleConfig / readLinkedCashoutAccounts in
// app/lib/transferQueueSettings.ts, served by
// /api/configurations/transfer-queue-settings and its /linked-accounts
// route). NOT wired into any page or route.
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type RuleRow = {
  section: string;
  metric: string;
  operator: string;
  value1: number;
  value2: number | null;
  queueResult: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
};

export async function readTransferQueueRulesPg(): Promise<RuleRow[]> {
  const db = getDb();
  // Ordered by id (insertion order), not section text — the real sheet's
  // section order (cashout_day, cashout_extended, cashout_247, ...) isn't
  // alphabetical, and migrate-data.ts inserted rows in that same original
  // sheet order, so id ASC reproduces it; ordering by section text would
  // put "cashout_247" before "cashout_day" and silently misorder the
  // output relative to the real reader.
  const rows = await db.select().from(schema.transferQueueRules).orderBy(asc(schema.transferQueueRules.id));

  return rows.map((r) => ({
    section: r.section,
    metric: r.metric,
    operator: r.operator,
    value1: r.value1 === null ? 0 : Number(r.value1),
    value2: r.value2 === null ? null : Number(r.value2),
    queueResult: r.queueResult ?? '',
    enabled: r.enabled,
    updatedBy: r.updatedBy ?? '',
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export type BundleField = {
  field: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
};

// transfer_queue_bundle_settings has no updated_by/updated_at columns
// (never part of the migrated schema) — left '' same as the real reader's
// own fallback convention (readBundleConfig() does the same when the sheet
// range comes back empty).
export async function readBundleConfigPg(): Promise<BundleField[]> {
  const db = getDb();
  const rows = await db.select().from(schema.transferQueueBundleSettings);
  return rows.map((r) => ({ field: r.fieldName, value: r.fieldValue ?? '', updatedBy: '', updatedAt: '' }));
}

export type MetaConfig = { mode: 'production' | 'configuration'; version: number; updatedBy: string; updatedAt: string };

// Matches readMetaConfig()'s exact return shape. transfer_queue_meta_config
// is a singleton (one row) — no key-value reconstruction needed.
export async function readMetaConfigPg(): Promise<MetaConfig> {
  const db = getDb();
  const [row] = await db.select().from(schema.transferQueueMetaConfig).limit(1);
  if (!row) return { mode: 'configuration', version: 1, updatedBy: '', updatedAt: '' };
  return {
    mode: row.mode === 'production' ? 'production' : 'configuration',
    version: row.version,
    updatedBy: row.updatedBy ?? '',
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : '',
  };
}

// Matches readLinkedCashoutAccounts()'s exact return shape: Map<upper
// sendmoneyWalletName, upper cashoutAgentCode>.
export async function readLinkedAccountsPg(): Promise<Map<string, string>> {
  const db = getDb();
  const rows = await db
    .select({
      sendmoneyWalletName: schema.transferQueueLinkedAccounts.sendmoneyWalletName,
      cashoutAgentCode: schema.agents.agentCode,
    })
    .from(schema.transferQueueLinkedAccounts)
    .leftJoin(schema.agents, eq(schema.transferQueueLinkedAccounts.cashoutAgentId, schema.agents.id));

  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.cashoutAgentCode) map.set(r.sendmoneyWalletName.toUpperCase(), r.cashoutAgentCode.toUpperCase());
  }
  return map;
}
