ALTER TABLE "agents" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_import_matched_at" timestamp with time zone;