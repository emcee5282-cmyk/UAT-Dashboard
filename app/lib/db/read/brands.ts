// Phase 10 — the real, single source of truth for "what brand codes are
// valid for this product," replacing the hardcoded CASHOUT_BRAND_CODES+'SH'
// array importService.ts/settlementValidation.ts used to validate Settlement/
// Top Up uploads against. Read-only; brands themselves are still only ever
// created by scripts/migrate-data.ts's own getOrCreateBrand()/the Balance
// Limit upload's brand backfill — this file never writes.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';
export type BrandOption = { id: number; code: string };

export async function getBrandsForProduct(product: Product): Promise<BrandOption[]> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.brands.id, code: schema.brands.code })
    .from(schema.brands)
    .where(eq(schema.brands.product, product));
  return rows;
}
