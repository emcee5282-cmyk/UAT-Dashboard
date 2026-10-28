ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "team" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ip" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"actor_user_id" integer,
	"target_user_id" integer,
	"username_attempted" text,
	"ip" text,
	"user_agent" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_audit_log" ADD CONSTRAINT "auth_audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_audit_log" ADD CONSTRAINT "auth_audit_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_audit_log_created_at_idx" ON "auth_audit_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_audit_log_target_user_idx" ON "auth_audit_log" USING btree ("target_user_id");
