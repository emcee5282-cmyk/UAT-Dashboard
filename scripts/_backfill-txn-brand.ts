// Retroactive fix: every wallet_transactions row currently has brand_id =
// NULL (neither the original Sheets migration nor this session's own
// backfill scripts ever captured it), so the Settlement/TopUp pages fall
// back to the shop's computed DEFAULT brand (agents.brand_id) for every
// row — wrong whenever a shop's transactions were actually posted under a
// different brand than its own default. But the real per-row Brand is
// recoverable: the old sheet's own "To Agent" text carries it as a
// trailing "-<CODE>" suffix (e.g. "JETT056-M1", "N-B1PS1-JOKER001-NG-B2")
// that stripBrandSuffix always threw away instead of capturing. This
// re-fetches the same sheet rows (same sourceRowRef scheme
// "{product}:{block}:{row}" as scripts/migrate-data.ts's
// importWalletTransactions and this session's own backfill), re-derives
// each row's real suffix, and updates brand_id for every existing row
// that's still NULL.
//
// Read-only dry run by default — pass --apply to actually write.
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { fetchRange } from '../app/lib/googleSheets';
import { cleanText } from '../app/lib/db/sync/estimatedOpeningSync';

const APPLY = process.argv.includes('--apply');
type Product = 'cashout' | 'sendmoney';

// Matches stripBrandSuffix's own shape-matching, but keeps the code instead
// of discarding it. 'SH' included — a real brand for both products (see
// brands table); 'BRAND' deliberately excluded — a stray, non-brand
// artifact row, never a legitimate per-row suffix.
const BRAND_SUFFIX_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
function extractBrandSuffix(name: string): string | null {
  const trimmed = name.trim();
  const parts = trimmed.split('-');
  const last = parts[parts.length - 1]?.trim().toUpperCase();
  if (parts.length >= 2 && BRAND_SUFFIX_CODES.includes(last)) return last;
  return null;
}

async function backfillProduct(product: Product) {
  const db = getDb();
  const sheetName = product === 'cashout' ? 'AG BD STLM + TOPUP' : 'PS BD STLM + TOPUP';
  const rows = await fetchRange(sheetName);

  const brandRows = await db.select().from(schema.brands).where(eq(schema.brands.product, product));
  const brandIdByCode = new Map(brandRows.map((b) => [b.code.toUpperCase(), b.id]));

  // sourceRowRef -> brandId, derived fresh from the sheet.
  const brandBySourceRef = new Map<string, number>();
  function scanBlock(block: 'topup' | 'settlement', agentCol: number) {
    rows.slice(1).forEach((row, i) => {
      const sourceRowRef = `${product}:${block}:${i + 2}`;
      const raw = cleanText(row[agentCol]);
      if (!raw || raw === '-') return;
      const suffix = extractBrandSuffix(raw);
      if (!suffix) return;
      const brandId = brandIdByCode.get(suffix);
      if (!brandId) return;
      brandBySourceRef.set(sourceRowRef, brandId);
    });
  }
  scanBlock('topup', 1);
  scanBlock('settlement', 7);

  // Every existing row for this product still missing brand_id.
  const existing = await db
    .select({ id: schema.walletTransactions.id, sourceRowRef: schema.walletTransactions.sourceRowRef })
    .from(schema.walletTransactions)
    .where(and(eq(schema.walletTransactions.product, product), isNull(schema.walletTransactions.brandId)));

  const updates: { id: number; brandId: number }[] = [];
  let noRef = 0, noSuffixMatch = 0;
  for (const row of existing) {
    if (!row.sourceRowRef) { noRef++; continue; } // this session's earlier date-range backfill rows keep this ref — should all have one
    const brandId = brandBySourceRef.get(row.sourceRowRef);
    if (!brandId) { noSuffixMatch++; continue; }
    updates.push({ id: row.id, brandId });
  }

  console.log(`\n=== ${product} ===`);
  console.log(`Existing rows with brand_id NULL: ${existing.length}`);
  console.log(`Recoverable (will update): ${updates.length}`);
  console.log(`No sourceRowRef at all (can't recover): ${noRef}`);
  console.log(`Has ref but no suffix match in current sheet: ${noSuffixMatch}`);

  if (APPLY && updates.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const values = sql.join(chunk.map((u) => sql`(${u.id}::bigint, ${u.brandId}::int)`), sql`, `);
      await db.execute(sql`
        UPDATE wallet_transactions AS w
        SET brand_id = v.brand_id
        FROM (VALUES ${values}) AS v(id, brand_id)
        WHERE w.id = v.id
      `);
    }
    console.log(`Applied: updated ${updates.length} rows.`);
  }
}

async function main() {
  await backfillProduct('cashout');
  await backfillProduct('sendmoney');
  if (!APPLY) console.log('\nDry run only — re-run with --apply to write.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
