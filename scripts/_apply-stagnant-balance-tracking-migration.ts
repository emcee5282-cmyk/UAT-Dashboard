// One-off, idempotent apply of drizzle/0041_add_stagnant_balance_tracking.sql
// — drizzle-kit migrate has a known pre-existing gap in this project (see
// migration 0038/0039/0040's own apply scripts). Run with:
// npx tsx --env-file=.env.local scripts/_apply-stagnant-balance-tracking-migration.ts
import { getDb } from '../app/lib/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "stagnant_balance_tracking" (
      "id" serial PRIMARY KEY NOT NULL,
      "agent_id" integer NOT NULL,
      "no_data_streak_days" integer DEFAULT 0 NOT NULL,
      "last_checked_cutoff_date" date,
      "updated_at" timestamp with time zone,
      CONSTRAINT "stagnant_balance_tracking_agent_id_unique" UNIQUE("agent_id")
    )
  `);
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "stagnant_balance_tracking" ADD CONSTRAINT "stagnant_balance_tracking_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  console.log('Migration 0041 applied (idempotent).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
