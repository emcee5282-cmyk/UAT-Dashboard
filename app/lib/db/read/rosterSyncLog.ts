// PostgreSQL read-layer mirror of fetchRosterCutoffDate()
// (app/lib/db/sync/estimatedOpeningSync.ts), which reads the "Opening AG"
// roster's own self-reported "Updated Time" card live from Google Sheets on
// every call. roster_sync_log stores that exact same value — populated by
// importRosterSyncLog() (scripts/migrate-data.ts, part of the fast sync
// group) calling fetchRosterCutoffDate() and inserting a new row ONLY when
// the card's value has actually changed (see that function's own dedup
// check) — so this table is never bumped by a sync that merely re-confirms
// an unchanged card, exactly mirroring the card's own semantics rather than
// "when did a sync last run" (agents.updated_at would be the wrong source
// for that reason — see roster_sync_log's own schema comment).
//
// Freshness here is "as of the last time a sync captured this signal," the
// same standard already applied to every other Postgres-sourced table in
// this service (agents.opening_balance, agent_wallets, etc.) — not a
// continuously-live value. That's the intended model going forward: state
// persists until the next deliberate sync/import, no background polling
// required.
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export async function readRosterCutoffPg(product: Product): Promise<Date | null> {
  const db = getDb();
  const [row] = await db
    .select({ syncedAt: schema.rosterSyncLog.syncedAt })
    .from(schema.rosterSyncLog)
    .where(eq(schema.rosterSyncLog.product, product))
    .orderBy(desc(schema.rosterSyncLog.syncedAt))
    .limit(1);
  return row ? row.syncedAt : null;
}

// "When was Opening last refreshed" — sourced from import_batches' own live
// completedAt (the daily Bulk Import Opening wizard already logs this on
// every real run), NOT readRosterCutoffPg's roster_sync_log above —
// confirmed via direct query to hold just a handful of rows, never updated
// by any live route (see readRosterCutoffPg's own callers' comments).
// Duplicates app/lib/services/balanceService.ts's own private
// readLatestOpeningImportCutoff (same query) rather than importing it —
// that file imports FROM app/lib/db/read/estimatedOpening.ts, which itself
// needs this same signal, so importing balanceService.ts there would be
// circular. This file has no such dependency either direction, so it's the
// safe common home for both estimatedOpening.ts and estimatedOpeningService.ts.
export async function readLatestOpeningImportCutoffPg(product: Product): Promise<Date | null> {
  const db = getDb();
  const [row] = await db
    .select({ completedAt: schema.importBatches.completedAt })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.product, product),
        eq(schema.importBatches.importType, 'opening'),
        eq(schema.importBatches.status, 'completed')
      )
    )
    .orderBy(desc(schema.importBatches.completedAt))
    .limit(1);
  return row?.completedAt ?? null;
}
