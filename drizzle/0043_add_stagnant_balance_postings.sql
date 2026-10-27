CREATE TABLE IF NOT EXISTS "stagnant_balance_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"agent_id" integer NOT NULL,
	"wallet_suffix" text DEFAULT '' NOT NULL,
	"shop_name" text NOT NULL,
	"first_posted_on" date NOT NULL,
	"last_seen_on" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stagnant_balance_postings" ADD CONSTRAINT "stagnant_balance_postings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stagnant_balance_postings_agent_suffix_uq" ON "stagnant_balance_postings" USING btree ("agent_id","wallet_suffix");
