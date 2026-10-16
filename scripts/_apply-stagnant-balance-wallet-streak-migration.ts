// One-off, idempotent apply of
// drizzle/0042_add_stagnant_balance_wallet_streak.sql — drizzle-kit migrate
// has a known pre-existing gap in this project (see migration 0041's own
// apply script). Run with:
// npx tsx --env-file=.env.local scripts/_apply-stagnant-balance-wallet-streak-migration.ts
import { getDb } from '../app/lib/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "stagnant_balance_wallet_streak" (
      "id" serial PRIMARY KEY NOT NULL,
      "agent_id" integer NOT NULL REFERENCES "agents"("id"),
      "wallet_suffix" text DEFAULT '' NOT NULL,
      "no_data_streak_days" integer DEFAULT 0 NOT NULL,
      "file_as_of_date" date,
      "updated_at" timestamp with time zone
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "stagnant_balance_wallet_streak_agent_suffix_uq" ON "stagnant_balance_wallet_streak" USING btree ("agent_id","wallet_suffix")
  `);
  console.log('Migration 0042 (stagnant_balance_wallet_streak) applied (idempotent).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
