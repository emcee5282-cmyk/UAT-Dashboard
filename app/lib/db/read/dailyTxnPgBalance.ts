// Reads for daily_txn_pg_balance_entry — Report tab's "PG Closing Balances"
// card (PgClosingBalancesCard), per PG key x brand.
import { and, desc, eq, isNotNull, lt, lte } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type DailyTxnPgBalanceRow = {
  pgKey: string;
  brand: string;
  amount: number | null;
  updatedAt: Date;
};

export async function getDailyTxnPgBalance(businessDate: string): Promise<DailyTxnPgBalanceRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      pgKey: schema.dailyTxnPgBalanceEntry.pgKey,
      brand: schema.dailyTxnPgBalanceEntry.brand,
      amount: schema.dailyTxnPgBalanceEntry.amount,
      updatedAt: schema.dailyTxnPgBalanceEntry.updatedAt,
    })
    .from(schema.dailyTxnPgBalanceEntry)
    .where(eq(schema.dailyTxnPgBalanceEntry.businessDate, businessDate));

  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

// Retention: 1 week, hard delete.
export async function deletePgBalanceOlderThan(cutoffDate: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.dailyTxnPgBalanceEntry).where(lt(schema.dailyTxnPgBalanceEntry.businessDate, cutoffDate));
}

export type PgBalanceSnapshot = { businessDate: string; values: Record<string, number>; updatedAt: Date };

// Report tab's PG Closing Balance is now the PRIMARY source for the
// Operations tab's "Opening Balance" row (per explicit instruction) — this
// finds the most recent business date (on or before `today`) that has at
// least one real (non-null) amount recorded for this PG, and returns every
// brand's value as of THAT date. Report tab's own cards start each new day
// blank (no carry-forward, see dailyTxnPgBalanceEntry's schema.ts comment)
// — so "today" itself may have nothing yet, and this deliberately looks
// backward for the last real snapshot rather than only checking today.
// Returns null if this PG has never had a real value recorded at all — the
// caller falls back to dailyTxnLedgerEntry's own internal opening in that
// case (kept specifically as a backup/recording copy, not the primary
// source, per explicit instruction).
export async function getLatestPgBalanceSnapshot(pgKey: string, today: string): Promise<PgBalanceSnapshot | null> {
  const db = getDb();
  const [latest] = await db
    .select({ businessDate: schema.dailyTxnPgBalanceEntry.businessDate })
    .from(schema.dailyTxnPgBalanceEntry)
    .where(
      and(
        eq(schema.dailyTxnPgBalanceEntry.pgKey, pgKey),
        lte(schema.dailyTxnPgBalanceEntry.businessDate, today),
        isNotNull(schema.dailyTxnPgBalanceEntry.amount)
      )
    )
    .orderBy(desc(schema.dailyTxnPgBalanceEntry.businessDate))
    .limit(1);
  if (!latest) return null;

  const rows = await db
    .select({ brand: schema.dailyTxnPgBalanceEntry.brand, amount: schema.dailyTxnPgBalanceEntry.amount, updatedAt: schema.dailyTxnPgBalanceEntry.updatedAt })
    .from(schema.dailyTxnPgBalanceEntry)
    .where(and(eq(schema.dailyTxnPgBalanceEntry.pgKey, pgKey), eq(schema.dailyTxnPgBalanceEntry.businessDate, latest.businessDate)));

  const values: Record<string, number> = {};
  let updatedAt = new Date(0);
  for (const r of rows) {
    if (r.amount !== null) {
      values[r.brand] = Number(r.amount);
      if (r.updatedAt > updatedAt) updatedAt = r.updatedAt;
    }
  }
  return { businessDate: latest.businessDate, values, updatedAt };
}
