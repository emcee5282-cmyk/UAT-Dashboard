ALTER TABLE "opening_wallet_lines" ADD COLUMN "sdp" numeric(18, 2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "opening_wallet_lines" ALTER COLUMN "sdp" DROP DEFAULT;
