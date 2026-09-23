// Verify upsertPgBalanceEntries only bumps updated_at when the amount
// genuinely changes — rolled back at the end, nothing persists.
import { eq, and } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const ROLLBACK_SENTINEL = new Error('__ROLLBACK__');

async function main() {
  const db = getDb();

  const [existing] = await db.select().from(schema.dailyTxnPgBalanceEntry)
    .where(and(eq(schema.dailyTxnPgBalanceEntry.pgKey, 'autopay'), eq(schema.dailyTxnPgBalanceEntry.brand, 'M1')))
    .orderBy(schema.dailyTxnPgBalanceEntry.businessDate)
    .limit(1);
  console.log('Sample row before:', existing);
  if (!existing) { console.log('No sample row found — pick a different pgKey/brand.'); process.exit(0); }

  try {
    await db.transaction(async (tx) => {
      // 1. Save the SAME amount back — updated_at must NOT change.
      await tx.execute(`
        INSERT INTO daily_txn_pg_balance_entry (pg_key, brand, business_date, amount, updated_at)
        VALUES ('${existing.pgKey}', '${existing.brand}', '${existing.businessDate}', ${existing.amount}, now())
        ON CONFLICT (pg_key, brand, business_date)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          updated_at = CASE WHEN daily_txn_pg_balance_entry.amount IS DISTINCT FROM EXCLUDED.amount THEN now() ELSE daily_txn_pg_balance_entry.updated_at END
      `);
      const [afterSameValue] = await tx.select().from(schema.dailyTxnPgBalanceEntry)
        .where(and(eq(schema.dailyTxnPgBalanceEntry.pgKey, existing.pgKey), eq(schema.dailyTxnPgBalanceEntry.brand, existing.brand), eq(schema.dailyTxnPgBalanceEntry.businessDate, existing.businessDate)));
      console.log('\nAfter saving the SAME amount:');
      console.log('  updated_at unchanged?', afterSameValue.updatedAt.getTime() === existing.updatedAt.getTime(), afterSameValue.updatedAt);

      // 2. Save a DIFFERENT amount — updated_at MUST change.
      const newAmount = (Number(existing.amount) + 1).toFixed(2);
      await tx.execute(`
        INSERT INTO daily_txn_pg_balance_entry (pg_key, brand, business_date, amount, updated_at)
        VALUES ('${existing.pgKey}', '${existing.brand}', '${existing.businessDate}', ${newAmount}, now())
        ON CONFLICT (pg_key, brand, business_date)
        DO UPDATE SET
          amount = EXCLUDED.amount,
          updated_at = CASE WHEN daily_txn_pg_balance_entry.amount IS DISTINCT FROM EXCLUDED.amount THEN now() ELSE daily_txn_pg_balance_entry.updated_at END
      `);
      const [afterDifferentValue] = await tx.select().from(schema.dailyTxnPgBalanceEntry)
        .where(and(eq(schema.dailyTxnPgBalanceEntry.pgKey, existing.pgKey), eq(schema.dailyTxnPgBalanceEntry.brand, existing.brand), eq(schema.dailyTxnPgBalanceEntry.businessDate, existing.businessDate)));
      console.log('\nAfter saving a DIFFERENT amount (+1):');
      console.log('  amount:', afterDifferentValue.amount, '| updated_at changed?', afterDifferentValue.updatedAt.getTime() !== existing.updatedAt.getTime(), afterDifferentValue.updatedAt);

      throw ROLLBACK_SENTINEL;
    });
  } catch (e) {
    if (e !== ROLLBACK_SENTINEL) throw e;
  }
  console.log('\nRolled back — nothing persisted.');

  const [afterRollback] = await db.select().from(schema.dailyTxnPgBalanceEntry)
    .where(and(eq(schema.dailyTxnPgBalanceEntry.pgKey, existing.pgKey), eq(schema.dailyTxnPgBalanceEntry.brand, existing.brand), eq(schema.dailyTxnPgBalanceEntry.businessDate, existing.businessDate)));
  console.log('Confirmed row unchanged after rollback:', afterRollback.updatedAt.getTime() === existing.updatedAt.getTime());

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
