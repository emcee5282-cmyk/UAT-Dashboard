ALTER TABLE "wallet_transactions" ADD COLUMN "brand_id" integer;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_tx_brand_id_idx" ON "wallet_transactions" USING btree ("brand_id");