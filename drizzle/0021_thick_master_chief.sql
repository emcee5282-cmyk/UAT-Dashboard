CREATE TABLE "daily_txn_wallet_breakdown_totals" (
	"id" serial PRIMARY KEY NOT NULL,
	"upload_id" integer NOT NULL,
	"wallet" text NOT NULL,
	"total_dp" numeric(18, 2) NOT NULL,
	"total_wd" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_txn_wallet_breakdown_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_name" text,
	"row_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_txn_wallet_breakdown_totals" ADD CONSTRAINT "daily_txn_wallet_breakdown_totals_upload_id_daily_txn_wallet_breakdown_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."daily_txn_wallet_breakdown_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_wallet_breakdown_totals_uq" ON "daily_txn_wallet_breakdown_totals" USING btree ("upload_id","wallet");