ALTER TABLE "discrepancy_tg_config" ADD COLUMN "cashout_threshold" integer DEFAULT 20000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_config" ADD COLUMN "sendmoney_threshold" integer DEFAULT 10000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "photos_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "albums_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "pdf_sent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "shops_total" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "shops_in_photos" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discrepancy_tg_send_log" ADD COLUMN "threshold_used" integer DEFAULT 0 NOT NULL;
