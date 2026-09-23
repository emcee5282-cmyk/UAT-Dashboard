// Reads for app/daily-txn-entry's Operations tab (LedgerCard/LEDGERS) — see
// daily_txn_ledger_entry's own header comment in schema.ts for the shape
// rationale. `rowKey` validity (standard vs 'ess' split) is enforced by the
// caller (the page already knows each ledger's own `kind`), not here.
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type DailyTxnLedgerRow = {
  ledgerId: string;
  brand: string;
  rowKey: string;
  amount: number;
  updatedAt: Date;
};

export async function getDailyTxnLedgerEntries(businessDate: string): Promise<DailyTxnLedgerRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      ledgerId: schema.dailyTxnLedgerEntry.ledgerId,
      brand: schema.dailyTxnLedgerEntry.brand,
      rowKey: schema.dailyTxnLedgerEntry.rowKey,
      amount: schema.dailyTxnLedgerEntry.amount,
      updatedAt: schema.dailyTxnLedgerEntry.updatedAt,
    })
    .from(schema.dailyTxnLedgerEntry)
    .where(eq(schema.dailyTxnLedgerEntry.businessDate, businessDate));

  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

// The rollover job's day-walking loop starts from (latest recorded business
// date) + 1 rather than assuming exactly "yesterday" — this is how it finds
// that starting point. Returns null if the table is empty (first run ever).
export async function getLatestLedgerBusinessDate(): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ businessDate: schema.dailyTxnLedgerEntry.businessDate })
    .from(schema.dailyTxnLedgerEntry)
    .orderBy(desc(schema.dailyTxnLedgerEntry.businessDate))
    .limit(1);
  return row?.businessDate ?? null;
}

// One ledger+brand's rows for a single business date — used by the rollover
// job to compute that day's closing total before carrying it forward.
export async function getDailyTxnLedgerEntriesForDate(
  ledgerId: string,
  businessDate: string
): Promise<Pick<DailyTxnLedgerRow, 'ledgerId' | 'brand' | 'rowKey' | 'amount'>[]> {
  const db = getDb();
  const rows = await db
    .select({
      ledgerId: schema.dailyTxnLedgerEntry.ledgerId,
      brand: schema.dailyTxnLedgerEntry.brand,
      rowKey: schema.dailyTxnLedgerEntry.rowKey,
      amount: schema.dailyTxnLedgerEntry.amount,
    })
    .from(schema.dailyTxnLedgerEntry)
    .where(and(eq(schema.dailyTxnLedgerEntry.ledgerId, ledgerId), eq(schema.dailyTxnLedgerEntry.businessDate, businessDate)));

  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

// Retention: 30 days (see schema.ts comment — added so the carry-forward
// source row never grows unbounded, even though Operations tab itself has
// no stated retention). Hard delete, not a filtered read.
export async function deleteLedgerEntriesOlderThan(cutoffDate: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.dailyTxnLedgerEntry).where(lt(schema.dailyTxnLedgerEntry.businessDate, cutoffDate));
}
