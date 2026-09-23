ALTER TYPE "public"."ticket_message_sender_role" ADD VALUE 'system';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "staff_last_viewed_at" timestamp with time zone;