CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sync_group" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"inserted_total" integer,
	"updated_total" integer,
	"skipped_total" integer,
	"rejected_total" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE INDEX "sync_runs_group_started_idx" ON "sync_runs" USING btree ("sync_group","started_at");