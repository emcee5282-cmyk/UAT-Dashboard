CREATE TYPE "public"."ticket_priority" AS ENUM('urgent', 'moderate', 'normal');--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "priority" "ticket_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "priority_source" text;