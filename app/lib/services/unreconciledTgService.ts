// Server-side read/write for Settings > Unreconciled TG — a separate
// feature from Discrepancy TG (its own token, its own group rows). Group
// Name is free text here (no leader search/dropdown/forced uppercase,
// unlike discrepancyTgService.ts) since a group isn't routed to a
// specific leader — every configured group receives the same broadcast.
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';

const TG_ID_PATTERN = /^-?\d+$/;

export type UnreconciledTgGroupRow = {
  id: number;
  groupName: string;
  tgId: string;
};

export type UnreconciledTgData = {
  rows: UnreconciledTgGroupRow[];
  token: string | null;
  lastUpdate: { updatedAt: string; updatedBy: string } | null;
};

export async function getUnreconciledTgData(): Promise<UnreconciledTgData> {
  const db = getDb();
  const [groupRows, configRows] = await Promise.all([
    db.select().from(schema.unreconciledTgGroups).orderBy(schema.unreconciledTgGroups.id),
    db.select().from(schema.unreconciledTgConfig).limit(1),
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
    rows: groupRows.map((r) => ({ id: r.id, groupName: r.groupName, tgId: r.tgId })),
    token: config?.botToken ?? null,
    lastUpdate,
  };
}

export type UnreconciledTgSaveInput = {
  token: string;
  rows: { groupName: string; tgId: string }[];
};

// Server-side mirror of the client's own validation — Group Name is
// required free text (trimmed, NOT uppercased, no dropdown match
// required); TG ID is required and must match the Telegram chat-id shape.
// Duplicate TG IDs are rejected (duplicate group NAMES aren't checked —
// two differently-named rows pointing at the same TG ID is a real,
// supported case elsewhere in this app's other TG settings, but two rows
// resolving to the SAME destination here would just double-send the same
// album to the same group, which the duplicate-TG-ID check already
// catches).
export function validateUnreconciledTgSave(input: UnreconciledTgSaveInput): string | null {
  const seenTgIds = new Set<string>();
  for (const row of input.rows) {
    const name = row.groupName.trim();
    const tgId = row.tgId.trim();
    if (!name && !tgId) continue; // dropped silently, not an error

    if (!name) return 'Group name required.';
    if (!tgId) return `TG ID required for ${name}.`;
    if (!TG_ID_PATTERN.test(tgId)) return `Invalid TG ID for ${name}.`;
    if (seenTgIds.has(tgId)) return 'TG ID already exists.';
    seenTgIds.add(tgId);
  }
  return null;
}

export async function saveUnreconciledTgData(input: UnreconciledTgSaveInput, updatedBy: string): Promise<void> {
  const error = validateUnreconciledTgSave(input);
  if (error) throw new Error(error);

  const cleanRows = input.rows
    .map((r) => ({ groupName: r.groupName.trim(), tgId: r.tgId.trim() }))
    .filter((r) => r.groupName || r.tgId);

  const updatedAt = new Date();
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.delete(schema.unreconciledTgGroups);
    if (cleanRows.length > 0) {
      await tx.insert(schema.unreconciledTgGroups).values(cleanRows.map((r) => ({ ...r, updatedBy, updatedAt })));
    }

    const [existingConfig] = await tx.select({ id: schema.unreconciledTgConfig.id }).from(schema.unreconciledTgConfig).limit(1);
    const token = input.token.trim() || null;
    if (existingConfig) {
      await tx.update(schema.unreconciledTgConfig).set({ botToken: token, updatedBy, updatedAt }).where(sql`${schema.unreconciledTgConfig.id} = ${existingConfig.id}`);
    } else {
      await tx.insert(schema.unreconciledTgConfig).values({ botToken: token, updatedBy, updatedAt });
    }
  });
}
