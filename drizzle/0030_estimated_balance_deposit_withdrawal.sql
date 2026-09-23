ALTER TABLE "estimated_balance_entries" ADD COLUMN "deposit" numeric(18, 2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "estimated_balance_entries" ALTER COLUMN "deposit" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "estimated_balance_entries" ADD COLUMN "withdrawal" numeric(18, 2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "estimated_balance_entries" ALTER COLUMN "withdrawal" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ADD COLUMN "deposit" numeric(18, 2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ALTER COLUMN "deposit" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ADD COLUMN "withdrawal" numeric(18, 2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ALTER COLUMN "withdrawal" DROP DEFAULT;
