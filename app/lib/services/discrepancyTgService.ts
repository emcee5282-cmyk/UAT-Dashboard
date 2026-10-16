// Server-side read/write for Settings > Discrepancy TG — the admin-only
// table of per-leader Telegram group IDs (plus the shared bot token) that a
// later, not-yet-built phase will use to send each leader their Discrepancy
// Summary image. This file only stores the settings; nothing here sends
// anything.
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getDiscrepancySummaryRows } from './discrepancySummaryService';

const TG_ID_PATTERN = /^-?\d+$/;

export type DiscrepancyTgGroupRow = {
  id: number;
  groupName: string;
  tgIdCashout: string | null;
  tgIdSendmoney: string | null;
};

export type DiscrepancyTgData = {
  rows: DiscrepancyTgGroupRow[];
  token: string | null;
  // Send to TG v2 — Agent Withdrawal thresholds deciding which shops go
  // into the photos (never saved yet = the plan's own defaults).
  cashoutThreshold: number;
  sendmoneyThreshold: number;
  lastUpdate: { updatedAt: string; updatedBy: string } | null;
};

// Same leader universe as the Balance tab / Discrepancy Summary tab (union
// of Cashout + Send Money, placeholder leaders already excluded by
// getDiscrepancySummaryRows) — reused rather than re-querying balances just
// for names, per explicit instruction.
export async function getDiscrepancyTgLeaderOptions(): Promise<string[]> {
  const rows = await getDiscrepancySummaryRows();
  return Array.from(new Set(rows.map((r) => r.leader))).sort((a, b) => a.localeCompare(b));
}

export async function getDiscrepancyTgData(): Promise<DiscrepancyTgData> {
  const db = getDb();
  const [groupRows, configRows] = await Promise.all([
    db.select().from(schema.discrepancyTgGroups).orderBy(schema.discrepancyTgGroups.id),
    db.select().from(schema.discrepancyTgConfig).limit(1),
  ]);

  const config = configRows[0] ?? null;

  let lastUpdate: { updatedAt: string; updatedBy: string } | null = null;
  for (const r of [...groupRows, ...(config ? [config] : [])]) {
    if (!r.updatedAt) continue;
    if (!lastUpdate || new Date(r.updatedAt) > new Date(lastUpdate.updatedAt)) {
      lastUpdate = { updatedAt: new Date(r.updatedAt).toISOString(), updatedBy: r.updatedBy ?? '' };
    }
  }

  return {
    rows: groupRows.map((r) => ({ id: r.id, groupName: r.groupName, tgIdCashout: r.tgIdCashout, tgIdSendmoney: r.tgIdSendmoney })),
    token: config?.botToken ?? null,
    cashoutThreshold: config?.cashoutThreshold ?? 20000,
    sendmoneyThreshold: config?.sendmoneyThreshold ?? 10000,
    lastUpdate,
  };
}

export type DiscrepancyTgSaveInput = {
  token: string;
  cashoutThreshold: number;
  sendmoneyThreshold: number;
  rows: { groupName: string; tgIdCashout: string | null; tgIdSendmoney: string | null }[];
};

// Server-side mirror of the client's own validation (section 4 of the
// spec) — "Leader not found" is deliberately NOT checked here, it's a
// warning only and never blocks Save on either side.
export function validateDiscrepancyTgSave(input: DiscrepancyTgSaveInput): string | null {
  if (!Number.isInteger(input.cashoutThreshold) || input.cashoutThreshold < 0) return 'Cashout threshold must be a whole number, 0 or greater.';
  if (!Number.isInteger(input.sendmoneyThreshold) || input.sendmoneyThreshold < 0) return 'Send Money threshold must be a whole number, 0 or greater.';

  const seen = new Set<string>();
  for (const row of input.rows) {
    const name = row.groupName.trim();
    const cashout = (row.tgIdCashout ?? '').trim();
    const sendmoney = (row.tgIdSendmoney ?? '').trim();
    if (!name && !cashout && !sendmoney) continue; // dropped silently, not an error

    if (!name) return 'Group name required.';
    if (seen.has(name)) return `Leader group already exists: ${name}`;
    seen.add(name);

    if (cashout && !TG_ID_PATTERN.test(cashout)) return `Invalid TG ID Cashout for ${name}.`;
    if (sendmoney && !TG_ID_PATTERN.test(sendmoney)) return `Invalid TG ID Send Money for ${name}.`;
  }
  return null;
}

// Replaces the full row set and the token in one transaction — "one save
// covers everything" (section 3.1). Empty rows (all three cells blank) are
// dropped; everything else is re-validated server-side (never trust the
// client-side check alone).
export async function saveDiscrepancyTgData(input: DiscrepancyTgSaveInput, updatedBy: string): Promise<void> {
  const error = validateDiscrepancyTgSave(input);
  if (error) throw new Error(error);

  const cleanRows = input.rows
    .map((r) => ({
      groupName: r.groupName.trim().toUpperCase(),
      tgIdCashout: (r.tgIdCashout ?? '').trim() || null,
      tgIdSendmoney: (r.tgIdSendmoney ?? '').trim() || null,
    }))
    .filter((r) => r.groupName || r.tgIdCashout || r.tgIdSendmoney);

  const updatedAt = new Date();
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.delete(schema.discrepancyTgGroups);
    if (cleanRows.length > 0) {
      await tx.insert(schema.discrepancyTgGroups).values(cleanRows.map((r) => ({ ...r, updatedBy, updatedAt })));
    }

    const [existingConfig] = await tx.select({ id: schema.discrepancyTgConfig.id }).from(schema.discrepancyTgConfig).limit(1);
    const token = input.token.trim() || null;
    const configValues = { botToken: token, cashoutThreshold: input.cashoutThreshold, sendmoneyThreshold: input.sendmoneyThreshold, updatedBy, updatedAt };
    if (existingConfig) {
      await tx.update(schema.discrepancyTgConfig).set(configValues).where(sql`${schema.discrepancyTgConfig.id} = ${existingConfig.id}`);
    } else {
      await tx.insert(schema.discrepancyTgConfig).values(configValues);
    }
  });
}
