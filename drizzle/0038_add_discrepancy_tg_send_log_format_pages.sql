ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "format" text DEFAULT 'photos' NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "pages" integer DEFAULT 0 NOT NULL;
