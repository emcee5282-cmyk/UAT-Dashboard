ALTER TABLE "agents" ADD COLUMN "previous_opening_balance" numeric(18, 2);
--> statement-breakpoint
ALTER TABLE "opening_wallet_lines" ADD COLUMN "previous_opening_balance" numeric(18, 2);
