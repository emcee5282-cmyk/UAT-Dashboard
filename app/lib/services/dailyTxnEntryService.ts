// Write-side for app/daily-txn-entry's 4 data surfaces — one upsert per
// (surface's unique index), wrapped in a transaction per Save so a partial
// failure never leaves half a ledger's cells written. Same
// insert(...).onConflictDoUpdate({ target: [uniqueIndexCols], set: {...} })
// idiom as importService.ts's importOpeningFile(). Kept as a loop of
// single-row upserts rather than one bulk multi-row upsert — a Save writes
// at most a few dozen cells, and looping inside one transaction avoids
// needing Postgres's `excluded.<col>` reference syntax that a true bulk
// upsert would require.
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';

export type LedgerEntryInput = {
  ledgerId: string;
  brand: string;
  rowKey: string;
  businessDate: string;
  amount: number;
};

export async function upsertLedgerEntries(entries: LedgerEntryInput[]): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx
        .insert(schema.dailyTxnLedgerEntry)
        .values({ ledgerId: e.ledgerId, brand: e.brand, rowKey: e.rowKey, businessDate: e.businessDate, amount: String(e.amount) })
        .onConflictDoUpdate({
          target: [
            schema.dailyTxnLedgerEntry.ledgerId,
            schema.dailyTxnLedgerEntry.brand,
            schema.dailyTxnLedgerEntry.rowKey,
            schema.dailyTxnLedgerEntry.businessDate,
          ],
          set: { amount: String(e.amount), updatedAt: new Date() },
        });
    }
  });
}

export type CashgoEntryInput = {
  businessDate: string;
  channel: 'bkash' | 'nagad';
  target: number | null;
  process: number | null;
};

export async function upsertCashgoEntry(entry: CashgoEntryInput): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.dailyTxnCashgoEntry)
    .values({
      businessDate: entry.businessDate,
      channel: entry.channel,
      target: entry.target === null ? null : String(entry.target),
      process: entry.process === null ? null : String(entry.process),
    })
    .onConflictDoUpdate({
      target: [schema.dailyTxnCashgoEntry.businessDate, schema.dailyTxnCashgoEntry.channel],
      set: {
        target: entry.target === null ? null : String(entry.target),
        process: entry.process === null ? null : String(entry.process),
        updatedAt: new Date(),
      },
    });
}

export type WalletClosingEntryInput = {
  ledgerId: 'ssp1' | 'ssp2';
  wallet: string;
  businessDate: string;
  amount: number | null;
};

export async function upsertWalletClosingEntries(entries: WalletClosingEntryInput[]): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx
        .insert(schema.dailyTxnWalletClosingEntry)
        .values({
          ledgerId: e.ledgerId,
          wallet: e.wallet,
          businessDate: e.businessDate,
          amount: e.amount === null ? null : String(e.amount),
        })
        .onConflictDoUpdate({
          target: [schema.dailyTxnWalletClosingEntry.ledgerId, schema.dailyTxnWalletClosingEntry.wallet, schema.dailyTxnWalletClosingEntry.businessDate],
          set: { amount: e.amount === null ? null : String(e.amount), updatedAt: new Date() },
        });
    }
  });
}

export type PgBalanceEntryInput = {
  pgKey: string;
  brand: string;
  businessDate: string;
  amount: number | null;
};

export async function upsertPgBalanceEntries(entries: PgBalanceEntryInput[]): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const e of entries) {
      const amountValue = e.amount === null ? null : String(e.amount);
      // updated_at only advances when this row's own amount actually
      // changed — the Save button commits every cell in the grid at once
      // (one shared Edit/Save for the whole table, not per-PG-column), so
      // an unconditional `updatedAt: new Date()` here was bumping EVERY
      // PG's "Last Update" on every save, even for PGs nobody touched.
      // Per explicit instruction: only the PG(s) whose figures genuinely
      // changed should show a new "Last Update" — everything else keeps
      // its own prior timestamp. IS DISTINCT FROM (not !=) so NULL-to-
      // NULL (an already-blank cell saved again) correctly counts as "no
      // change" too, which a plain != would get wrong (NULL != NULL is
      // NULL/false in SQL, not true, but being explicit here documents the
      // intent rather than relying on that).
      await tx.execute(sql`
        INSERT INTO daily_txn_pg_balance_entry (pg_key, brand, business_date, amount, updated_at)
        VALUES (${e.pgKey}, ${e.brand}, ${e.businessDate}, ${amountValue}, now())
        ON CONFLICT (pg_key, brand, business_date)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          updated_at = CASE
            WHEN daily_txn_pg_balance_entry.amount IS DISTINCT FROM EXCLUDED.amount THEN now()
            ELSE daily_txn_pg_balance_entry.updated_at
          END
      `);
    }
  });
}

