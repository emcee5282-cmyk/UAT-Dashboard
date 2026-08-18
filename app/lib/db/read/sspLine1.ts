// Phase 10 — SSP Line 1's Top Up/Settlement, read from PostgreSQL using
// each transaction's own stored brand_id — never agents.brand_id, never
// the deprecated resolveSspLine1Brand/resolveSendMoneyBrandFromWalletName
// name-parsing formulas. `brand_id IS NOT NULL` is what implements the
// "fresh start" boundary: every historical row synced before this column
// existed is permanently NULL there (never backfilled, per explicit
// instruction), so this filter alone — with no separate cutoff-date field
// — naturally excludes all pre-existing history and includes only
// transactions uploaded through the new Brand-required flow.
//
// Static fields (Opening Balance/Deposit/Withdrawal/Adjustment/Total) are
// deliberately NOT read here — per explicit instruction they stay blank
// until a dedicated upload system for them exists later. This file only
// ever produces the Top Up/Settlement half of SSP Line 1.
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type SspLine1TopUpSettlement = {
  brand: string;
  topUp: number;
  settlement: number;
};

// `cutoffDate` is the same business-day cutoff app/page.tsx already
// computes client-side (today, unless the Opening roster card is stale and
// no valid same-day Estimated Balance covers the gap) — passed in rather
// than re-derived here, so this stays a single, un-duplicated copy of that
// rule instead of a second, possibly-diverging one.
export async function getSspLine1TopUpSettlement(product: Product, cutoffDate: string): Promise<SspLine1TopUpSettlement[]> {
  const db = getDb();
  const rows = await db
    .select({
      brandCode: schema.brands.code,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.brands, eq(schema.walletTransactions.brandId, schema.brands.id))
    .where(and(
      eq(schema.walletTransactions.product, product),
      isNotNull(schema.walletTransactions.brandId),
      gte(schema.walletTransactions.occurredOn, cutoffDate)
    ));

  const totals = new Map<string, { topUp: number; settlement: number }>();
  for (const r of rows) {
    const existing = totals.get(r.brandCode) ?? { topUp: 0, settlement: 0 };
    const amount = Number(r.amount);
    if (r.transactionType === 'topup') existing.topUp += amount;
    else existing.settlement += amount;
    totals.set(r.brandCode, existing);
  }

  return Array.from(totals.entries()).map(([brand, v]) => ({ brand, topUp: v.topUp, settlement: v.settlement }));
}
