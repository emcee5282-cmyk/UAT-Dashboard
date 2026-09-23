// Reads for daily_txn_wallet_closing_entry — Report tab's "Wallet Breakdown
// Opening" card (YesterdayClosingCard, rendered once each for ssp1/ssp2).
import { and, eq, lte, desc, lt } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type DailyTxnWalletClosingRow = {
  wallet: string;
  amount: number | null;
  updatedAt: Date;
};

export async function getDailyTxnWalletClosing(ledgerId: 'ssp1' | 'ssp2', businessDate: string): Promise<DailyTxnWalletClosingRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      wallet: schema.dailyTxnWalletClosingEntry.wallet,
      amount: schema.dailyTxnWalletClosingEntry.amount,
      updatedAt: schema.dailyTxnWalletClosingEntry.updatedAt,
    })
    .from(schema.dailyTxnWalletClosingEntry)
    .where(and(eq(schema.dailyTxnWalletClosingEntry.ledgerId, ledgerId), eq(schema.dailyTxnWalletClosingEntry.businessDate, businessDate)));

  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

// Per explicit instruction — the Estimated tab's own Wallet Breakdown card
// (unlike the Operations tab's editable YesterdayClosingCard, which must
// keep showing blank for today until someone actually enters it) should
// never show blank just because nobody has entered TODAY's Wallet
// Breakdown Opening yet: it should carry forward the most recent entry per
// wallet (on or before businessDate) so an Estimated figure can still be
// computed. Retention on this table is only 1 week (see
// deleteWalletClosingOlderThan below), so "most recent" is always a
// recent, real, previously-entered figure — never falls back arbitrarily
// far into the past. A separate function (not a change to
// getDailyTxnWalletClosing above) since that one's exact-date behavior is
// still correct and needed for the Operations tab's own editable form.
export async function getLatestDailyTxnWalletClosing(ledgerId: 'ssp1' | 'ssp2', onOrBeforeBusinessDate: string): Promise<DailyTxnWalletClosingRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      wallet: schema.dailyTxnWalletClosingEntry.wallet,
      amount: schema.dailyTxnWalletClosingEntry.amount,
      updatedAt: schema.dailyTxnWalletClosingEntry.updatedAt,
      businessDate: schema.dailyTxnWalletClosingEntry.businessDate,
    })
    .from(schema.dailyTxnWalletClosingEntry)
    .where(and(eq(schema.dailyTxnWalletClosingEntry.ledgerId, ledgerId), lte(schema.dailyTxnWalletClosingEntry.businessDate, onOrBeforeBusinessDate)))
    .orderBy(desc(schema.dailyTxnWalletClosingEntry.businessDate));

  const latestByWallet = new Map<string, DailyTxnWalletClosingRow>();
  for (const r of rows) {
    if (latestByWallet.has(r.wallet)) continue; // already-ordered by businessDate DESC — first hit per wallet is the most recent
    latestByWallet.set(r.wallet, { wallet: r.wallet, amount: r.amount === null ? null : Number(r.amount), updatedAt: r.updatedAt });
  }
  return Array.from(latestByWallet.values());
}

// Retention: 1 week, hard delete.
export async function deleteWalletClosingOlderThan(cutoffDate: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.dailyTxnWalletClosingEntry).where(lt(schema.dailyTxnWalletClosingEntry.businessDate, cutoffDate));
}
