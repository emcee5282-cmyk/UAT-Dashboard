CREATE TABLE IF NOT EXISTS "unreconciled_tg_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_name" text NOT NULL,
	"tg_id" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "unreconciled_tg_groups_group_name_unique" UNIQUE("group_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unreconciled_tg_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_token" text,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	"send_locked_at" timestamp with time zone
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unreconciled_tg_send_log_run_at_idx" ON "unreconciled_tg_send_log" USING btree ("run_at");
