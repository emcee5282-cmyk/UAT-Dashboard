// Postgres-only Estimated Opening upload — no Google Sheets read or write.
// Replaces the old two-stage flow (writeCashoutEstimatedOpening/
// writeSendMoneyEstimatedOpening → syncEstimatedOpeningToPostgres) for the
// upload routes only. Those Sheets-based functions are left fully intact
// (unchanged) — they're still used by the Sheets-mode "Opening" page's own
// GET /api/{opening,sendmoney/opening}/estimated-balance routes and by
// scripts/migrate-data.ts's full migration, neither of which this task
// touches.
//
// Reuses the same pure aggregation/validation logic the old Sheets path
// already relied on (aggregateByShop, aggregateByWalletType — both now
// exported from estimatedOpening.ts, not duplicated) and the same output
// timestamp format (formatUploadTimestamp) so the client UI's display
// logic (formatImportTimestamp, which only parses that exact
// "MM/DD/YYYY HH:MM AM/PM" shape) needs no changes.
//
// Formula (must match writeCashoutEstimatedOpening's/writeSendMoneyEstimated
// Opening's documented formula exactly — only the INPUT SOURCE changes):
//   assumedBalance = openingBalance + uploadedTotalDP - uploadedTotalWD + topUp - settlement
// Sign note: the old Sheets-based formula ADDED settlement because the sheet
// itself stores Settlement as an already-negative number ("kept at its own
// natural sign"). wallet_transactions.amount is always stored as a positive
// magnitude here (sign implied by transaction_type, per that column's own
// schema comment) — so the equivalent net effect requires SUBTRACTING it
// instead, exactly the same translation balanceService.ts's
// computeCompanyBalance() already applies for the live dashboard's own
// Company Balance formula. Verified numerically against the old formula in
// this task's own testing, not just reasoned about.
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { aggregateByShop, aggregateByWalletType, formatUploadTimestamp } from '../estimatedOpening';
import { extractRealShopName, extractSendMoneyShopName } from '../realShopName';
import { readRosterCutoffPg } from '../db/read/rosterSyncLog';

export type Product = 'cashout' | 'sendmoney';

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

// Same Manila-midnight-Date -> 'YYYY-MM-DD' derivation balanceService.ts
// already uses for businessTodayStr, reused here for consistency — both
// values ultimately come from the same manilaMidnight() construction
// (getBusinessToday() / fetchRosterCutoffDate(), see rosterSyncLog.ts).
export function toDateOnlyString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export type EstimatedOpeningUploadResult = { uploadedAt: string; shopCount: number };

export async function importEstimatedOpeningFromUpload(
  product: Product,
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  fileName: string,
  uploadedBy = 'Operations Admin'
): Promise<EstimatedOpeningUploadResult> {
  const db = getDb();

  // Server-side validation + aggregation — throws (findColumn) if the
  // uploaded file is missing a required column; silently excludes any row
  // with a non-numeric DP/WD cell (isValidNumericCell, inside
  // aggregateByShop) — same rules the old Sheets path already enforced,
  // not new ones.
  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;
  const shopTotals = aggregateByShop(headerRow, dataRows, extractShopName);
  const walletTotals = aggregateByWalletType(headerRow, dataRows);
  if (shopTotals.length === 0) {
    throw new Error('No valid shop rows found in the uploaded file.');
  }

  const cutoffDate = await readRosterCutoffPg(product);
  if (!cutoffDate) {
    throw new Error(`No roster cutoff signal available for ${product} yet — run a sync at least once before uploading.`);
  }
  const cutoffDateStr = toDateOnlyString(cutoffDate);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentByCode = new Map(agentRows.map((a) => [a.agentCode, a]));

  // Single grouped query for that one cutoff day's Top Up/Settlement across
  // every agent — not one query per shop (explicit performance requirement).
  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
    })
    .from(schema.walletTransactions)
    .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, cutoffDateStr)));

  const txByAgentId = new Map<number, { topUp: number; settlement: number }>();
  for (const t of txRows) {
    const bucket = txByAgentId.get(t.agentId) ?? { topUp: 0, settlement: 0 };
    if (t.transactionType === 'topup') bucket.topUp += n(t.amount);
    else bucket.settlement += n(t.amount);
    txByAgentId.set(t.agentId, bucket);
  }

  type NewEntry = { agentId: number; assumedBalance: number };
  const entries: NewEntry[] = [];
  for (const s of shopTotals) {
    const agent = agentByCode.get(s.shopName);
    if (!agent) continue; // no matching roster agent — skip, same as the old Postgres mirror's own rejected-row handling, not a hard failure
    const opening = n(agent.openingBalance);
    const tx = txByAgentId.get(agent.id) ?? { topUp: 0, settlement: 0 };
    const assumedBalance = opening + s.totalDP - s.totalWD + tx.topUp - tx.settlement;
    entries.push({ agentId: agent.id, assumedBalance });
  }
  if (entries.length === 0) {
    throw new Error('None of the uploaded shops matched a known agent — check the file is for the correct product.');
  }

  const uploadedAtDate = new Date();

  await db.transaction(async (tx) => {
    const [upload] = await tx
      .insert(schema.estimatedBalanceUploads)
      .values({
        product,
        uploadedBy,
        uploadedAt: uploadedAtDate,
        cutoffDate: cutoffDateStr,
        fileName,
        shopCount: shopTotals.length,
      })
      .returning({ id: schema.estimatedBalanceUploads.id });

    await tx.insert(schema.estimatedBalanceEntries).values(
      entries.map((e) => ({ uploadId: upload.id, agentId: e.agentId, assumedBalance: String(e.assumedBalance) }))
    );

    if (walletTotals.length > 0) {
      await tx.insert(schema.estimatedBalanceWalletTotals).values(
        walletTotals.map((w) => ({ uploadId: upload.id, walletType: w.wallet, totalDp: String(w.totalDP), totalWd: String(w.totalWD) }))
      );
    }
  });

  return { uploadedAt: formatUploadTimestamp(uploadedAtDate), shopCount: shopTotals.length };
}
