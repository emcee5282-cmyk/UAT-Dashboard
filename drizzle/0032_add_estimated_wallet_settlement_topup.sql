ALTER TABLE "estimated_balance_wallet_totals" ADD COLUMN "settlement" numeric(18, 2);
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_totals" ADD COLUMN "topup" numeric(18, 2);
