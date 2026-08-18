// PostgreSQL read-layer mirror of "Brand Balance" reads
// (/api/brand-ssp-line1 [Cashout, B3:G13] and /api/brand-ssp-line1-sendmoney
// [Send Money, B16:G26] — same 6-column shape, both reused by app/page.tsx's
// shared parseSspLine1(); and /api/brand-cash-inhand). NOT wired into any
// page or route.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

const SSP_HEADER = ['Brand', 'Opening Balance', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'TOTAL'];

function cell(val: string | null): string {
  return val ?? '';
}

// Matches fetchRange('Brand Balance!B3:G13' / 'B16:G26') exactly: header +
// 10 data rows, 6 columns [code, opening, deposit, withdrawal, adjustment,
// total]. Both products now backfilled — importBrandSspLine1() was fixed
// to skip this same header row instead of migrating it as a fake brand
// (previously produced a bogus code="BRAND" row with all-null values).
export async function readBrandSspLine1Pg(product: Product): Promise<string[][]> {
  const db = getDb();
  const rows = await db
    .select({
      code: schema.brands.code,
      openingBalance: schema.brandSspLine1.openingBalance,
      deposit: schema.brandSspLine1.deposit,
      withdrawal: schema.brandSspLine1.withdrawal,
      adjustment: schema.brandSspLine1.adjustment,
      total: schema.brandSspLine1.total,
    })
    .from(schema.brandSspLine1)
    .innerJoin(schema.brands, eq(schema.brandSspLine1.brandId, schema.brands.id))
    .where(eq(schema.brandSspLine1.product, product));

  const dataRows = rows.map((r) => [r.code, cell(r.openingBalance), cell(r.deposit), cell(r.withdrawal), cell(r.adjustment), cell(r.total)]);
  return [SSP_HEADER, ...dataRows];
}

const CIH_HEADER = ['Brand', 'SSP AG', 'SSP PS', 'ESS', 'AUTOPAY', 'EXPAY', 'Total Brand CIH'];

// Matches fetchRange('Brand Balance!B29:H40') shape: header + data rows.
// The real sheet also has a manual "TOTAL" summary row (12 rows incl.
// header vs. 11 here) that migrate-data.ts deliberately did not migrate
// (a sheet-side computed row, not source data) — not reproduced here
// either, to avoid inventing a new total-computation business rule.
export async function readBrandCashInhandPg(): Promise<string[][]> {
  const db = getDb();
  const rows = await db
    .select({
      code: schema.brands.code,
      sspAg: schema.brandCashInhand.sspAg,
      sspPs: schema.brandCashInhand.sspPs,
      ess: schema.brandCashInhand.ess,
      autopay: schema.brandCashInhand.autopay,
      expay: schema.brandCashInhand.expay,
      totalCih: schema.brandCashInhand.totalCih,
    })
    .from(schema.brandCashInhand)
    .innerJoin(schema.brands, eq(schema.brandCashInhand.brandId, schema.brands.id));

  const dataRows = rows.map((r) => [r.code, cell(r.sspAg), cell(r.sspPs), cell(r.ess), cell(r.autopay), cell(r.expay), cell(r.totalCih)]);
  return [CIH_HEADER, ...dataRows];
}
