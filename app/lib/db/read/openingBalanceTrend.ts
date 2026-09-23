// Running Balance card's trend sparkline — reads the snapshots
// importService.ts's importOpeningFile() writes on every completed Opening
// upload (see openingBalanceDaily's own schema comment). Only ever has data
// from whenever that write path first shipped forward; no historical
// backfill exists.
import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type OpeningBalanceTrendPoint = { trendDate: string; totalAmount: number };

export async function getOpeningBalanceTrend(product: Product, sinceDate: string): Promise<OpeningBalanceTrendPoint[]> {
  const db = getDb();
  const rows = await db
    .select({ trendDate: schema.openingBalanceDaily.trendDate, totalAmount: schema.openingBalanceDaily.totalAmount })
    .from(schema.openingBalanceDaily)
    .where(and(eq(schema.openingBalanceDaily.product, product), gte(schema.openingBalanceDaily.trendDate, sinceDate)))
    .orderBy(schema.openingBalanceDaily.trendDate);

  return rows.map((r) => ({ trendDate: r.trendDate, totalAmount: Number(r.totalAmount) }));
}
