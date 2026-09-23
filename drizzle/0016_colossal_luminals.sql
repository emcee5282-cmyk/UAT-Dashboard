ALTER TABLE "ticket_messages" ADD COLUMN "attachment_data" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "attachment_mime_type" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "attachment_name" text;