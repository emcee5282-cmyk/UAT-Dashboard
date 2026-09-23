ALTER TABLE "estimated_balance_wallet_lines" DROP COLUMN "raw_agent_name";
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ADD COLUMN "wallet_type" text NOT NULL;
