CREATE TABLE IF NOT EXISTS "stagnant_balance_wallet_streak" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"wallet_suffix" text DEFAULT '' NOT NULL,
	"no_data_streak_days" integer DEFAULT 0 NOT NULL,
	"file_as_of_date" date,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stagnant_balance_wallet_streak" ADD CONSTRAINT "stagnant_balance_wallet_streak_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stagnant_balance_wallet_streak_agent_suffix_uq" ON "stagnant_balance_wallet_streak" USING btree ("agent_id","wallet_suffix");
