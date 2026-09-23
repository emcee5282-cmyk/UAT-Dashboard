CREATE TABLE "daily_txn_estimated_opening_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"upload_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"assumed_balance" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_txn_estimated_opening_entries" ADD CONSTRAINT "daily_txn_estimated_opening_entries_upload_id_daily_txn_wallet_breakdown_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."daily_txn_wallet_breakdown_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_txn_estimated_opening_entries" ADD CONSTRAINT "daily_txn_estimated_opening_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_txn_estimated_opening_entries_upload_id_idx" ON "daily_txn_estimated_opening_entries" USING btree ("upload_id");