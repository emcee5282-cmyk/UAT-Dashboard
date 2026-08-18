// PostgreSQL read-layer mirror of "CashGo" reads (/api/cashgo ->
// fetchRange('CashGo!A2:F'), no header — data starts at row 2 in both the
// real reader and here). NOT wired into any page or route. Cashout only —
// cashgo_daily has no real Send Money data (Send Money's Bundle Transfer
// Trend is computed live from wallet_transactions instead, confirmed in
// the schema's own comment).
import { and, eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Reverses parseCashGoDate()'s "YYYY-MM-DD" -> "Month D" (no year, matching
// the sheet's own convention).
function toCashGoDateLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

function cell(val: string | null): string {
  return val ?? '';
}

export async function readCashgoDailyPg(product: Product): Promise<string[][]> {
  if (product !== 'cashout') return [];
  const db = getDb();
  const rows = await db.select().from(schema.cashgoDaily).where(eq(schema.cashgoDaily.product, product));

  const byDate = new Map<string, { bkashQuota?: string | null; nagadQuota?: string | null; bkashProcessed?: string | null; nagadProcessed?: string | null }>();
  for (const r of rows) {
    if (!byDate.has(r.trendDate)) byDate.set(r.trendDate, {});
    const entry = byDate.get(r.trendDate)!;
    if (r.walletType === 'BKASH') {
      entry.bkashQuota = r.quota;
      entry.bkashProcessed = r.processed;
    } else if (r.walletType === 'NAGAD') {
      entry.nagadQuota = r.quota;
      entry.nagadProcessed = r.processed;
    }
  }

  const sortedDates = [...byDate.keys()].sort();
  return sortedDates.map((date) => {
    const e = byDate.get(date)!;
    return ['', toCashGoDateLabel(date), cell(e.bkashQuota ?? null), cell(e.nagadQuota ?? null), cell(e.bkashProcessed ?? null), cell(e.nagadProcessed ?? null)];
  });
}
