ALTER TABLE "wallet_status_overrides" DROP CONSTRAINT "wallet_status_overrides_agent_id_unique";--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD COLUMN "wallet_id" integer;--> statement-breakpoint
ALTER TABLE "wallet_status_overrides" ADD COLUMN "wallet_id" integer;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_overrides" ADD CONSTRAINT "wallet_status_overrides_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_status_history_wallet_id_idx" ON "wallet_status_history" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_status_overrides_wallet_uq" ON "wallet_status_overrides" USING btree ("wallet_id") WHERE "wallet_status_overrides"."wallet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_status_overrides_agent_only_uq" ON "wallet_status_overrides" USING btree ("agent_id") WHERE "wallet_status_overrides"."wallet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "wallet_status_overrides_agent_id_idx" ON "wallet_status_overrides" USING btree ("agent_id");