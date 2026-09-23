CREATE TABLE "opening_wallet_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"raw_agent_name" text NOT NULL,
	"opening_balance" numeric(18, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_wallet_lines" ADD CONSTRAINT "opening_wallet_lines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_wallet_lines_agent_id_idx" ON "opening_wallet_lines" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "agent_wallets" DROP COLUMN "opening_balance";--> statement-breakpoint
ALTER TABLE "agent_wallets" DROP COLUMN "opening_raw_agent_name";