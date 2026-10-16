CREATE TABLE IF NOT EXISTS "stagnant_balance_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"no_data_streak_days" integer DEFAULT 0 NOT NULL,
	"last_checked_cutoff_date" date,
	"updated_at" timestamp with time zone,
	CONSTRAINT "stagnant_balance_tracking_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
ALTER TABLE "stagnant_balance_tracking" ADD CONSTRAINT "stagnant_balance_tracking_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
