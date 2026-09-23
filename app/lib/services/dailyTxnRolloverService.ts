// Nightly rollover for app/daily-txn-entry — triggered once a day by
// app/api/admin/daily-txn-rollover (external VPS cron, ~12:00 AM), never by
// page load. See daily_txn_rollover_runs' schema.ts comment for why a plain
// mutex isn't enough here: a legitimate SEQUENTIAL re-trigger for a business
// date that already succeeded would silently double-apply the ledger
// carry-forward math, not just race a concurrent one.
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getBusinessToday, manilaFields } from '../businessDate';
import {
  getLatestLedgerBusinessDate,
  getDailyTxnLedgerEntriesForDate,
  deleteLedgerEntriesOlderThan,
} from '../db/read/dailyTxnLedger';
import { deleteWalletClosingOlderThan } from '../db/read/dailyTxnWalletClosing';
import { deletePgBalanceOlderThan } from '../db/read/dailyTxnPgBalance';
import { deleteCashgoEntriesOlderThan } from '../db/read/dailyTxnCashgo';
import { upsertLedgerEntries, type LedgerEntryInput } from './dailyTxnEntryService';

const LEDGER_IDS = ['ssp1', 'ssp2', 'ess', 'atp', 'expay', 'hkpay'] as const;
const ESS_LEDGER_ID = 'ess';
export const DAILY_TXN_LEDGER_BRANDS = ['M1', 'M2', 'K1', 'B1', 'B2', 'B3', 'B4', 'B5', 'T1', 'J1'] as const;
const BRANDS = DAILY_TXN_LEDGER_BRANDS;
const WALLET_LEDGER_IDS = ['ssp1', 'ssp2'] as const;
const WALLETS = ['Bkash', 'Nagad', 'Rocket', 'UPay'] as const;
const PG_KEYS = ['autopay', 'expay', 'ssp1', 'ssp2', 'essPg', 'hkpay'] as const;

const LEDGER_RETENTION_DAYS = 30;
const REPORT_RETENTION_DAYS = 7;
const CASHGO_RETENTION_DAYS = 60; // "2 months" — a fixed 60-day window rather than calendar-month arithmetic, simpler and close enough for a retention policy.

function toDateStr(d: Date): string {
  const { year, month, day } = manilaFields(d);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Same formula as computeTotal() in app/daily-txn-entry/page.tsx — kept in
// sync manually since the page is a client component and can't import a
// server-only service module. Exported so the Dashboard's own ledger-total
// reads (app/lib/db/read/dailyTxnLedger.ts) share this one implementation
// instead of a third copy.
export function computeClosingTotal(rows: { rowKey: string; amount: number }[], kind: 'standard' | 'ess'): number {
  const get = (key: string) => rows.find((r) => r.rowKey === key)?.amount ?? 0;
  if (kind === 'ess') {
    return get('opening') + get('dpBkash') + get('dpNagad') - get('wdBkash') - get('wdNagad') + get('adjustment');
  }
  return get('opening') + get('deposit') - get('withdrawal') + get('adjustment');
}

// Writes ONLY the 'opening' row for each (ledger, brand) on `newDate`,
// carried forward from `prevDate`'s computed closing total. Deposit /
// withdrawal / adjustment (or the ess split) are deliberately NOT zeroed
// here — their absence already reads as 0 via the page's own getVal()
// fallback, and zeroing them explicitly would risk clobbering real
// same-day entries a user made before this job got a chance to run (e.g.
// after a missed cron night, per the day-walking loop below).
async function carryForwardLedgerDay(prevDate: string, newDate: string): Promise<void> {
  for (const ledgerId of LEDGER_IDS) {
    const kind = ledgerId === ESS_LEDGER_ID ? 'ess' : 'standard';
    const prevRows = await getDailyTxnLedgerEntriesForDate(ledgerId, prevDate);
    const byBrand = new Map<string, { rowKey: string; amount: number }[]>();
    for (const r of prevRows) {
      const arr = byBrand.get(r.brand) ?? [];
      arr.push({ rowKey: r.rowKey, amount: r.amount });
      byBrand.set(r.brand, arr);
    }
    const entries: LedgerEntryInput[] = BRANDS.map((brand) => ({
      ledgerId,
      brand,
      rowKey: 'opening',
      businessDate: newDate,
      amount: computeClosingTotal(byBrand.get(brand) ?? [], kind),
    }));
    await upsertLedgerEntries(entries);
  }
}

// Ensures today's blank rows exist for the two "current" surfaces that
// start blank each day (no carry-forward — see schema.ts comment on why
// these two are different from the ledger table). Uses onConflictDoNothing
// specifically (not the Save-path upsert) so this never overwrites a value
// a user already entered for today.
async function ensureTodayBlankRows(today: string): Promise<void> {
  const db = getDb();
  for (const channel of ['bkash', 'nagad'] as const) {
    await db
      .insert(schema.dailyTxnCashgoEntry)
      .values({ businessDate: today, channel, target: null, process: null })
      .onConflictDoNothing({ target: [schema.dailyTxnCashgoEntry.businessDate, schema.dailyTxnCashgoEntry.channel] });
  }
  for (const ledgerId of WALLET_LEDGER_IDS) {
    for (const wallet of WALLETS) {
      await db
        .insert(schema.dailyTxnWalletClosingEntry)
        .values({ ledgerId, wallet, businessDate: today, amount: null })
        .onConflictDoNothing({
          target: [schema.dailyTxnWalletClosingEntry.ledgerId, schema.dailyTxnWalletClosingEntry.wallet, schema.dailyTxnWalletClosingEntry.businessDate],
        });
    }
  }
  for (const pgKey of PG_KEYS) {
    for (const brand of BRANDS) {
      await db
        .insert(schema.dailyTxnPgBalanceEntry)
        .values({ pgKey, brand, businessDate: today, amount: null })
        .onConflictDoNothing({
          target: [schema.dailyTxnPgBalanceEntry.pgKey, schema.dailyTxnPgBalanceEntry.brand, schema.dailyTxnPgBalanceEntry.businessDate],
        });
    }
  }
}

export type RolloverResult =
  | { ok: true; skipped: true; businessDate: string; reason: 'already-claimed' }
  | { ok: true; skipped: false; businessDate: string; ledgerDaysProcessed: number }
  | { ok: false; businessDate: string; error: string };

export async function runDailyTxnRollover(): Promise<RolloverResult> {
  const db = getDb();
  const today = toDateStr(getBusinessToday());

  // Atomic claim — a unique-violation here means another run is already
  // 'running' or already 'success' for today; a prior 'failure' row does
  // NOT block this (the partial unique index only covers running/success),
  // so a failed run is retryable.
  try {
    await db.insert(schema.dailyTxnRolloverRuns).values({ businessDate: today, status: 'running' });
  } catch {
    return { ok: true, skipped: true, businessDate: today, reason: 'already-claimed' };
  }

  try {
    // Ledger carry-forward — walk forward from the day after the latest
    // recorded ledger business date through today, one day at a time,
    // rather than assuming exactly "yesterday" was missed. Self-heals a
    // missed cron night instead of leaving a silent balance-correctness gap.
    const latest = await getLatestLedgerBusinessDate();
    let ledgerDaysProcessed = 0;
    if (latest !== null && latest < today) {
      let prevDate = latest;
      let cursor = addDays(latest, 1);
      while (cursor <= today) {
        await carryForwardLedgerDay(prevDate, cursor);
        prevDate = cursor;
        cursor = addDays(cursor, 1);
        ledgerDaysProcessed++;
      }
    }
    // If `latest` is null (first run ever, no ledger history at all yet),
    // deliberately do NOT invent an opening balance — 'opening' isn't
    // user-editable in the UI, so day-1 real values must be seeded directly
    // by whoever supplies the real starting data, not guessed here as 0.

    await ensureTodayBlankRows(today);

    // Retention — hard delete, not a filtered read (per explicit instruction).
    await deleteLedgerEntriesOlderThan(addDays(today, -LEDGER_RETENTION_DAYS));
    await deleteWalletClosingOlderThan(addDays(today, -REPORT_RETENTION_DAYS));
    await deletePgBalanceOlderThan(addDays(today, -REPORT_RETENTION_DAYS));
    await deleteCashgoEntriesOlderThan(addDays(today, -CASHGO_RETENTION_DAYS));

    await db
      .update(schema.dailyTxnRolloverRuns)
      .set({ status: 'success', finishedAt: new Date() })
      .where(and(eq(schema.dailyTxnRolloverRuns.businessDate, today), eq(schema.dailyTxnRolloverRuns.status, 'running')));

    return { ok: true, skipped: false, businessDate: today, ledgerDaysProcessed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.dailyTxnRolloverRuns)
      .set({ status: 'failure', finishedAt: new Date(), errorMessage: message })
      .where(and(eq(schema.dailyTxnRolloverRuns.businessDate, today), eq(schema.dailyTxnRolloverRuns.status, 'running')));
    return { ok: false, businessDate: today, error: message };
  }
}
