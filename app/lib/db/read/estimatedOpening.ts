// PostgreSQL read-layer mirror of readCashoutEstimatedOpening() /
// readSendMoneyEstimatedOpening() (app/lib/estimatedOpening.ts, served by
// /api/opening/estimated-balance and /api/sendmoney/opening/estimated-balance).
// NOT wired into any page or route.
//
// Reproduces `balances`, `walletTotals`, and `uploadedAt` exactly — these
// are just the stored upload, stable and fully derivable from Postgres.
//
// Deliberately does NOT reproduce `balancesWithFallback`: the real function
// computes it by blending the stored upload with LIVE Opening/Top Up/
// Settlement figures fetched fresh from Sheets at call time (via
// fetchLiveShopFigures(), itself filtered by a live cutoff-date card).
// Postgres's own agents/wallet_transactions data is a point-in-time
// snapshot from the last migration/sync, not live — computing this field
// against stale data would silently produce a wrong "live" value under a
// key name that looks correct. Returning it wrong would be worse than not
// returning it; this stays a documented gap until Postgres itself becomes
// live-synced.
//
// Also does NOT reproduce the API route's `lastImport` field (sourced from
// a separate readImportLog() call, a different concern from this domain) —
// out of scope for this pass.
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type EstimatedOpeningWalletTotals = { totalDP: number; totalWD: number };

export async function readEstimatedOpeningPg(product: Product): Promise<{
  balances: Map<string, number>;
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
}> {
  const db = getDb();
  const [latestUpload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(eq(schema.estimatedBalanceUploads.product, product))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);

  if (!latestUpload) {
    return { balances: new Map(), walletTotals: new Map(), uploadedAt: null };
  }

  const entries = await db
    .select({ agentCode: schema.agents.agentCode, assumedBalance: schema.estimatedBalanceEntries.assumedBalance })
    .from(schema.estimatedBalanceEntries)
    .innerJoin(schema.agents, eq(schema.estimatedBalanceEntries.agentId, schema.agents.id))
    .where(eq(schema.estimatedBalanceEntries.uploadId, latestUpload.id));

  const walletTotalsRows = await db
    .select()
    .from(schema.estimatedBalanceWalletTotals)
    .where(eq(schema.estimatedBalanceWalletTotals.uploadId, latestUpload.id));

  const balances = new Map<string, number>();
  for (const e of entries) balances.set(e.agentCode, Number(e.assumedBalance));

  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd) });

  return { balances, walletTotals, uploadedAt: latestUpload.uploadedAt };
}

// ---------------------------------------------------------------------------
// Phase 3 — full display contract for the Opening estimated-balance GET
// routes (app/api/{opening,sendmoney/opening}/estimated-balance), replacing
// readCashoutEstimatedOpening()/readSendMoneyEstimatedOpening()
// (app/lib/estimatedOpening.ts) for THAT runtime path only. Those Sheets
// functions are left completely unchanged — still used by
// scripts/migrate-data.ts and by the fallback-comparison logic these were
// ported from.
//
// Reproduces `balancesWithFallback` — every roster shop gets a value, not
// just ones in the latest upload — the same computation Phase 2's
// estimatedOpeningService.ts already established for the upload's own
// assumedBalance formula (opening + topUp − settlement, wallet_transactions'
// positive-magnitude sign convention), reused here rather than
// reimplemented, applied to shops the upload didn't cover. A shop already
// present in `balances` is used as-is (Phase 2's write already baked that
// cutoff day's TopUp/Settlement into it — adding it again would double
// count, exactly the same reasoning the old Sheets-based function documented
// for itself).
// ---------------------------------------------------------------------------
import { toDateOnlyString } from '../../services/estimatedOpeningService';
import { ESTIMATED_OPENING_EXCLUDED_LEADERS, formatUploadTimestamp } from '../../estimatedOpening';
import { readRosterCutoffPg } from './rosterSyncLog';

export type ImportLogEntry = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

export async function readEstimatedOpeningDisplayPg(product: Product): Promise<{
  balances: Map<string, number>;
  balancesWithFallback: Map<string, number>;
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
  lastImport: ImportLogEntry | null;
}> {
  const db = getDb();
  const [latestUpload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(eq(schema.estimatedBalanceUploads.product, product))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);

  const emptyResult = { balances: new Map<string, number>(), balancesWithFallback: new Map<string, number>(), walletTotals: new Map<string, EstimatedOpeningWalletTotals>(), uploadedAt: null, lastImport: null };
  if (!latestUpload) return emptyResult;

  const entries = await db
    .select({ agentCode: schema.agents.agentCode, assumedBalance: schema.estimatedBalanceEntries.assumedBalance })
    .from(schema.estimatedBalanceEntries)
    .innerJoin(schema.agents, eq(schema.estimatedBalanceEntries.agentId, schema.agents.id))
    .where(eq(schema.estimatedBalanceEntries.uploadId, latestUpload.id));

  const walletTotalsRows = await db.select().from(schema.estimatedBalanceWalletTotals).where(eq(schema.estimatedBalanceWalletTotals.uploadId, latestUpload.id));

  const balances = new Map<string, number>();
  for (const e of entries) balances.set(e.agentCode, Number(e.assumedBalance));

  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd) });

  // Every roster shop, with its leader (for the ONEMEN exclusion) —
  // mirrors the old function's own openingByShop/leaderByShop pair.
  const rosterRows = await db
    .select({ agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance, leaderName: schema.leaders.name })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(eq(schema.agents.product, product));

  const cutoffDate = await readRosterCutoffPg(product);
  const cutoffDateStr = cutoffDate ? toDateOnlyString(cutoffDate) : null;

  const txByAgentCode = new Map<string, { topUp: number; settlement: number }>();
  if (cutoffDateStr) {
    const txRows = await db
      .select({ agentCode: schema.agents.agentCode, transactionType: schema.walletTransactions.transactionType, amount: schema.walletTransactions.amount })
      .from(schema.walletTransactions)
      .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
      .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, cutoffDateStr)));
    for (const t of txRows) {
      const bucket = txByAgentCode.get(t.agentCode) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') bucket.topUp += Number(t.amount);
      else bucket.settlement += Number(t.amount);
      txByAgentCode.set(t.agentCode, bucket);
    }
  }

  const balancesWithFallback = new Map<string, number>();
  for (const roster of rosterRows) {
    if (ESTIMATED_OPENING_EXCLUDED_LEADERS.includes((roster.leaderName ?? '').trim().toUpperCase())) continue;
    const uploadedBase = balances.get(roster.agentCode);
    if (uploadedBase !== undefined) {
      balancesWithFallback.set(roster.agentCode, uploadedBase);
      continue;
    }
    const opening = roster.openingBalance === null ? 0 : parseFloat(roster.openingBalance);
    const tx = txByAgentCode.get(roster.agentCode) ?? { topUp: 0, settlement: 0 };
    balancesWithFallback.set(roster.agentCode, opening + tx.topUp - tx.settlement);
  }

  const lastImport: ImportLogEntry = {
    fileName: latestUpload.fileName ?? '',
    shopCount: latestUpload.shopCount ?? entries.length,
    // Same "MM/DD/YYYY HH:MM AM/PM" shape the old Sheets-based Import Log
    // cell text had — BulkImportModal.tsx's parseServerTimestamp() only
    // understands that exact format (see Phase 2's own note on this).
    importedAt: formatUploadTimestamp(latestUpload.uploadedAt),
    importedBy: latestUpload.uploadedBy,
  };

  return { balances, balancesWithFallback, walletTotals, uploadedAt: latestUpload.uploadedAt, lastImport };
}
