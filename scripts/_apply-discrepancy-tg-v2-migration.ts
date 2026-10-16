// One-off, idempotent apply of drizzle/0039_add_discrepancy_tg_v2_thresholds.sql —
// `npx drizzle-kit migrate` has a known pre-existing gap in this project
// (recorded a prior migration as applied without running its SQL), so DDL
// changes are applied directly via IF NOT EXISTS, same workaround used for
// migration 0038. Run with: npx tsx scripts/_apply-discrepancy-tg-v2-migration.ts
import { getDb } from '../app/lib/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db.execute(sql`ALTER TABLE "discrepancy_tg_config" ADD COLUMN IF NOT EXISTS "cashout_threshold" integer DEFAULT 20000 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_config" ADD COLUMN IF NOT EXISTS "sendmoney_threshold" integer DEFAULT 10000 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "photos_count" integer DEFAULT 0 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "albums_count" integer DEFAULT 0 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "pdf_sent" boolean DEFAULT false NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "shops_total" integer DEFAULT 0 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "shops_in_photos" integer DEFAULT 0 NOT NULL`);
  await db.execute(sql`ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN IF NOT EXISTS "threshold_used" integer DEFAULT 0 NOT NULL`);
  console.log('Migration 0039 applied (idempotent).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
