ALTER TYPE "public"."ticket_title" ADD VALUE IF NOT EXISTS 'topup_request';--> statement-breakpoint
ALTER TYPE "public"."ticket_title" ADD VALUE IF NOT EXISTS 'settlement_request';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "request_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "request_wallet" text;
