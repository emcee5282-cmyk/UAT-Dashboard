CREATE TABLE "discrepancy_tg_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_name" text NOT NULL,
	"tg_id_cashout" text,
	"tg_id_sendmoney" text,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "discrepancy_tg_groups_group_name_unique" UNIQUE("group_name")
);
--> statement-breakpoint
CREATE TABLE "discrepancy_tg_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_token" text,
	"updated_by" text,
	"updated_at" timestamp with time zone
);
