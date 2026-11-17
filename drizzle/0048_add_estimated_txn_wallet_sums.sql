CREATE TABLE IF NOT EXISTS "estimated_txn_wallet_sums" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"activity_date" date NOT NULL,
	"kind" text NOT NULL,
	"raw_account" text NOT NULL,
	"bank" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"txn_count" integer NOT NULL,
	"file_name" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimated_txn_wallet_sums_day_idx" ON "estimated_txn_wallet_sums" USING btree ("product","activity_date","kind");
