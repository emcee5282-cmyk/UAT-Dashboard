CREATE TABLE "discrepancy_tg_send_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"triggered_by" text NOT NULL,
	"leader" text NOT NULL,
	"line" text NOT NULL,
	"chat_id" text,
	"image_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE INDEX "discrepancy_tg_send_log_run_at_idx" ON "discrepancy_tg_send_log" USING btree ("run_at");
