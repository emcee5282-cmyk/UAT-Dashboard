// Shared PostgreSQL synchronization logic for the "Estimated Opening" data
// (Opening's real Google Sheets upload flow). Moved here from
// scripts/migrate-data.ts unchanged so BOTH the standalone historical
// migration script and the live upload API routes call the exact same
// code — no reimplementation, no drift between the two call sites.
//
// This module never writes to Google Sheets — it only reads back what a
// prior write already put there (via app/lib/estimatedOpening.ts's own
// read functions) and mirrors it into Postgres. Idempotent: re-running for
// the same (product, uploadedAt) is a no-op (see importEstimatedOpening).

import { eq, and } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import * as schema from '@/app/lib/db/schema';
import { fetchRange } from '@/app/lib/googleSheets';
import {
  readCashoutEstimatedOpening,
  readSendMoneyEstimatedOpening,
  readImportLog,
  readSendMoneyImportLog,
} from '@/app/lib/estimatedOpening';
// Real, shared Manila-timezone-safe date helpers — reused rather than
// re-implemented (see app/lib/businessDate.ts's own top comment for the
// production incident this class of bug has already caused once).
import { parseCardCutoffDate, fromManilaWallClockMs } from '@/app/lib/businessDate';

export type Product = 'cashout' | 'sendmoney';

const db = getDb();

// ---------------------------------------------------------------------------
// Logging — moved verbatim from scripts/migrate-data.ts (single source of
// truth). report() still serves the CLI script's full multi-table console
// output; getSummary() is additive, for callers (the upload API routes)
// that want a plain return value instead of console output.
// ---------------------------------------------------------------------------

type TableStats = { inserted: number; updated: number; skipped: number; rejected: number };

export class MigrationLogger {
  private stats = new Map<string, TableStats>();
  private rejections: { table: string; reason: string; raw: unknown }[] = [];
  private warnings: { table: string; reason: string; raw: unknown }[] = [];

  private bucket(table: string): TableStats {
    if (!this.stats.has(table)) this.stats.set(table, { inserted: 0, updated: 0, skipped: 0, rejected: 0 });
    return this.stats.get(table)!;
  }
  inserted(table: string, n = 1) { this.bucket(table).inserted += n; }
  updated(table: string, n = 1) { this.bucket(table).updated += n; }
  skipped(table: string, n = 1) { this.bucket(table).skipped += n; }
  rejected(table: string, reason: string, raw: unknown) {
    this.bucket(table).rejected += 1;
    this.rejections.push({ table, reason, raw });
  }
  warn(table: string, reason: string, raw: unknown) {
    this.warnings.push({ table, reason, raw });
  }

  report() {
    console.log('\n=== MIGRATION REPORT ===');
    const tableNames = Array.from(this.stats.keys()).sort();
    for (const table of tableNames) {
      const s = this.stats.get(table)!;
      console.log(
        `${table.padEnd(34)} inserted=${s.inserted}  updated=${s.updated}  skipped=${s.skipped}  rejected=${s.rejected}`
      );
    }
    if (this.warnings.length > 0) {
      console.log(`\n--- ${this.warnings.length} WARNING(S) (data imported, but see caveat) ---`);
      for (const w of this.warnings) console.log(`[${w.table}] ${w.reason}:`, JSON.stringify(w.raw));
    }
    console.log(`\nTotal rejected rows: ${this.rejections.length}`);
    if (this.rejections.length > 0) {
      console.log('--- Rejected rows (full list) ---');
      for (const r of this.rejections) {
        console.log(`[${r.table}] ${r.reason}:`, JSON.stringify(r.raw));
      }
    }
  }

  getSummary(): SyncOutcome {
    return {
      inserted: {
        uploads: this.stats.get('estimated_balance_uploads')?.inserted ?? 0,
        entries: this.stats.get('estimated_balance_entries')?.inserted ?? 0,
        walletTotals: this.stats.get('estimated_balance_wallet_totals')?.inserted ?? 0,
      },
      skipped: this.stats.get('estimated_balance_uploads')?.skipped ?? 0,
      rejectedCount: this.rejections.length,
      rejections: this.rejections,
      warnings: this.warnings,
    };
  }

  // Cross-table totals — for a scheduled/recurring caller (the sync_runs
  // logger) that needs "this run's" aggregate counts, not one specific
  // table's. Combined with reset(), lets the same shared logger instance
  // be reused correctly across many runs in one long-lived process instead
  // of accumulating forever (this class was originally written for a
  // single one-shot CLI invocation that always exited right after; a live
  // server calling it repeatedly via cron needs an explicit reset point).
  getTotals(): { inserted: number; updated: number; skipped: number; rejected: number } {
    const totals = { inserted: 0, updated: 0, skipped: 0, rejected: 0 };
    for (const s of this.stats.values()) {
      totals.inserted += s.inserted;
      totals.updated += s.updated;
      totals.skipped += s.skipped;
      totals.rejected += s.rejected;
    }
    return totals;
  }

  reset() {
    this.stats.clear();
    this.rejections = [];
    this.warnings = [];
  }
}

// ---------------------------------------------------------------------------
// Shared parsing helpers — moved verbatim from scripts/migrate-data.ts.
// Deliberately NOT the app's own rawVal() ("blank becomes '-' (truthy)" is
// a documented footgun elsewhere in this app) — NULL means NULL here.
// ---------------------------------------------------------------------------

export function cleanText(val: unknown): string {
  return String(val ?? '').replace(/"/g, '').trim();
}

// "MM/DD/YYYY HH:MM AM/PM" (Estimated Opening's "Last Updated:" cell).
// Verbatim port of estimatedOpening.ts's own (unexported) parseUploadTimestamp.
export function parseUploadTimestamp(str: string): Date | null {
  const match = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min, ampm] = match;
  let hours = parseInt(hh, 10);
  if (/PM/i.test(ampm) && hours !== 12) hours += 12;
  if (/AM/i.test(ampm) && hours === 12) hours = 0;
  const manilaWallClockMs = Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hours, parseInt(min, 10));
  return fromManilaWallClockMs(manilaWallClockMs);
}

// ---------------------------------------------------------------------------
// roster cutoff card (Opening AG col G/I) — also used by
// scripts/migrate-data.ts's own importRosterSyncLog().
// ---------------------------------------------------------------------------

export async function fetchRosterCutoffDate(product: Product): Promise<Date | null> {
  const range = product === 'cashout' ? 'Opening AG!G1:G10' : 'Opening AG!I1:I10';
  const rows = await fetchRange(range);
  for (const row of rows) {
    const parsed = parseCardCutoffDate(cleanText(row[0]));
    if (parsed) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// estimated_balance_uploads + _entries + _wallet_totals  <-  "Estimated Opening"
// Moved verbatim from scripts/migrate-data.ts. Skips entirely if an upload
// with the same (product, uploadedAt) already exists — the sheet only ever
// holds its single latest upload, so this is what makes re-runs (and the
// live upload route retrying after a transient Postgres error) never
// create a duplicate "upload event."
// ---------------------------------------------------------------------------

export async function importEstimatedOpening(product: Product, log: MigrationLogger) {
  const uploadsTable = 'estimated_balance_uploads';
  const [data, importLog] = await Promise.all([
    product === 'cashout' ? readCashoutEstimatedOpening() : readSendMoneyEstimatedOpening(),
    product === 'cashout' ? readImportLog() : readSendMoneyImportLog(),
  ]);
  if (data.balances.size === 0) {
    log.skipped(uploadsTable);
    return; // nothing uploaded yet for this product
  }
  const latestLog = importLog[0];
  const uploadedAt = data.uploadedAt ?? (latestLog ? parseUploadTimestamp(latestLog.importedAt) : null) ?? new Date();

  const existingUpload = await db
    .select({ id: schema.estimatedBalanceUploads.id })
    .from(schema.estimatedBalanceUploads)
    .where(and(eq(schema.estimatedBalanceUploads.product, product), eq(schema.estimatedBalanceUploads.uploadedAt, uploadedAt)));

  if (existingUpload.length > 0) {
    log.skipped(uploadsTable);
    return; // same upload already imported — sheet only ever holds its latest, so this is expected on re-run
  }

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode, a.id]));

  // Resolve the REAL reportCutoffDate: re-read the same Opening AG cutoff
  // card fetchLiveShopFigures()/fetchLiveSendMoneyShopFigures() use
  // internally (not exposed by the read functions above). Only trustworthy
  // if the roster hasn't refreshed since this upload happened — verified by
  // same-calendar-day comparison against uploadedAt, since the upload
  // workflow always bakes in "that single stale calendar day," which is
  // necessarily the same day the upload itself was made. If the roster has
  // since moved on, the live card no longer reflects history the sheet
  // never kept — falls back to uploadedAt's own date, logged explicitly
  // rather than silently presented as exact either way.
  const liveCutoff = await fetchRosterCutoffDate(product);
  const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  let cutoffDate: string;
  if (liveCutoff && sameDay(liveCutoff, uploadedAt)) {
    cutoffDate = liveCutoff.toISOString().slice(0, 10);
  } else {
    cutoffDate = uploadedAt.toISOString().slice(0, 10);
    log.warn(
      'estimated_balance_uploads.cutoff_date',
      'roster has refreshed since this upload — exact historical reportCutoffDate not recoverable, used uploaded_at date instead',
      { product, uploadedAt: uploadedAt.toISOString(), liveCutoff: liveCutoff?.toISOString() ?? null }
    );
  }

  await db.transaction(async (tx) => {
    const [upload] = await tx
      .insert(schema.estimatedBalanceUploads)
      .values({
        product,
        uploadedBy: latestLog?.importedBy || 'Operations Admin',
        uploadedAt,
        cutoffDate,
        fileName: latestLog?.fileName || null,
        shopCount: latestLog?.shopCount ?? data.balances.size,
      })
      .returning({ id: schema.estimatedBalanceUploads.id });
    log.inserted(uploadsTable);

    type NewEntry = typeof schema.estimatedBalanceEntries.$inferInsert;
    const entries: NewEntry[] = [];
    for (const [shopName, assumedBalance] of data.balances) {
      const agentId = agentIdByCode.get(shopName);
      if (!agentId) {
        log.rejected('estimated_balance_entries', `no matching agent for "${shopName}"`, { shopName, assumedBalance });
        continue;
      }
      entries.push({ uploadId: upload.id, agentId, assumedBalance: String(assumedBalance) });
    }
    if (entries.length > 0) await tx.insert(schema.estimatedBalanceEntries).values(entries);
    log.inserted('estimated_balance_entries', entries.length);

    type NewWalletTotal = typeof schema.estimatedBalanceWalletTotals.$inferInsert;
    const walletTotals: NewWalletTotal[] = Array.from(data.walletTotals.entries()).map(([walletType, t]) => ({
      uploadId: upload.id,
      walletType,
      totalDp: String(t.totalDP),
      totalWd: String(t.totalWD),
    }));
    if (walletTotals.length > 0) await tx.insert(schema.estimatedBalanceWalletTotals).values(walletTotals);
    log.inserted('estimated_balance_wallet_totals', walletTotals.length);
  });
}

// ---------------------------------------------------------------------------
// Public entry point for the live upload API routes (app/api/opening and
// app/api/sendmoney/opening's upload-estimated-balance routes). Pure
// function — no console output, no process.exit — so the caller decides
// how to log/react. Throws only on a genuine unexpected failure (e.g. a
// Postgres connection error); callers must catch this and must NEVER let
// it affect the already-successful Google Sheets write's HTTP response.
// ---------------------------------------------------------------------------

export type SyncOutcome = {
  inserted: { uploads: number; entries: number; walletTotals: number };
  skipped: number;
  rejectedCount: number;
  rejections: { table: string; reason: string; raw: unknown }[];
  warnings: { table: string; reason: string; raw: unknown }[];
};

export async function syncEstimatedOpeningToPostgres(product: Product): Promise<SyncOutcome> {
  const log = new MigrationLogger();
  await importEstimatedOpening(product, log);
  return log.getSummary();
}
