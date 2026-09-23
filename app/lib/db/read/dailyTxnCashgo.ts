// Reads for daily_txn_cashgo_entry — serves both the Operations tab's
// CashGoHourlyCard ("today", its newest business date) and the CashGo tab's
// CashGoDailyTargetCard history. See that table's header comment in
// schema.ts for why both live in one table.
import { and, asc, gte, lt, or, isNotNull, eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type DailyTxnCashgoRow = {
  businessDate: string;
  channel: 'bkash' | 'nagad';
  target: number | null;
  process: number | null;
  updatedAt: Date;
};

export async function getDailyTxnCashgoForDate(businessDate: string): Promise<DailyTxnCashgoRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      businessDate: schema.dailyTxnCashgoEntry.businessDate,
      channel: schema.dailyTxnCashgoEntry.channel,
      target: schema.dailyTxnCashgoEntry.target,
      process: schema.dailyTxnCashgoEntry.process,
      updatedAt: schema.dailyTxnCashgoEntry.updatedAt,
    })
    .from(schema.dailyTxnCashgoEntry)
    .where(eq(schema.dailyTxnCashgoEntry.businessDate, businessDate));

  return rows.map((r) => ({
    ...r,
    channel: r.channel as 'bkash' | 'nagad',
    target: r.target === null ? null : Number(r.target),
    process: r.process === null ? null : Number(r.process),
  }));
}

// History for CashGoDailyTargetCard — both channel rows are written every
// day for simplicity (see write side), but a channel with neither a target
// nor a process value that day is filtered out here so a quiet day doesn't
// grow a phantom row the old hardcoded seed never showed (e.g. a Nagad-quiet
// day should show no Nagad row at all, matching the pre-DB seed's own
// per-day curation).
export async function getDailyTxnCashgoHistory(sinceDate: string): Promise<DailyTxnCashgoRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      businessDate: schema.dailyTxnCashgoEntry.businessDate,
      channel: schema.dailyTxnCashgoEntry.channel,
      target: schema.dailyTxnCashgoEntry.target,
      process: schema.dailyTxnCashgoEntry.process,
      updatedAt: schema.dailyTxnCashgoEntry.updatedAt,
    })
    .from(schema.dailyTxnCashgoEntry)
    .where(
      and(
        gte(schema.dailyTxnCashgoEntry.businessDate, sinceDate),
        or(isNotNull(schema.dailyTxnCashgoEntry.target), isNotNull(schema.dailyTxnCashgoEntry.process))
      )
    )
    .orderBy(asc(schema.dailyTxnCashgoEntry.businessDate));

  return rows.map((r) => ({
    ...r,
    channel: r.channel as 'bkash' | 'nagad',
    target: r.target === null ? null : Number(r.target),
    process: r.process === null ? null : Number(r.process),
  }));
}

// Retention: 2 months, hard delete.
export async function deleteCashgoEntriesOlderThan(cutoffDate: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.dailyTxnCashgoEntry).where(lt(schema.dailyTxnCashgoEntry.businessDate, cutoffDate));
}
