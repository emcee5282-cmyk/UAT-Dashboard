CREATE TABLE "estimated_balance_wallet_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"upload_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"raw_agent_name" text NOT NULL,
	"assumed_balance" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ADD CONSTRAINT "estimated_balance_wallet_lines_upload_id_estimated_balance_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."estimated_balance_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_lines" ADD CONSTRAINT "estimated_balance_wallet_lines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimated_balance_wallet_lines_upload_id_idx" ON "estimated_balance_wallet_lines" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "estimated_balance_wallet_lines_agent_id_idx" ON "estimated_balance_wallet_lines" USING btree ("agent_id");