// One-off, idempotent apply of drizzle/0040_add_unreconciled_tg_tables.sql —
// drizzle-kit migrate has a known pre-existing gap in this project (see
// migration 0038/0039's own apply scripts). Run with:
// npx tsx --env-file=.env.local scripts/_apply-unreconciled-tg-migration.ts
import { getDb } from '../app/lib/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "unreconciled_tg_groups" (
      "id" serial PRIMARY KEY NOT NULL,
      "group_name" text NOT NULL,
      "tg_id" text NOT NULL,
      "updated_by" text,
      "updated_at" timestamp with time zone,
      CONSTRAINT "unreconciled_tg_groups_group_name_unique" UNIQUE("group_name")
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "unreconciled_tg_config" (
      "id" serial PRIMARY KEY NOT NULL,
      "bot_token" text,
      "updated_by" text,
      "updated_at" timestamp with time zone,
      "send_locked_at" timestamp with time zone
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "unreconciled_tg_send_log" (
      "id" serial PRIMARY KEY NOT NULL,
      "run_at" timestamp with time zone NOT NULL,
      "triggered_by" text NOT NULL,
      "group_name" text NOT NULL,
      "chat_id" text,
      "album_index" integer DEFAULT 1 NOT NULL,
      "albums_total" integer DEFAULT 1 NOT NULL,
      "image_count" integer DEFAULT 0 NOT NULL,
      "status" text NOT NULL,
      "reason" text
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "unreconciled_tg_send_log_run_at_idx" ON "unreconciled_tg_send_log" USING btree ("run_at")`);
  console.log('Migration 0040 applied (idempotent).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
