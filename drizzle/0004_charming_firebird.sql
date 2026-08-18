CREATE TYPE "public"."import_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_type" AS ENUM('settlement', 'topup', 'opening');--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"import_type" "import_type" NOT NULL,
	"file_name" text,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer,
	"valid_count" integer,
	"duplicate_count" integer,
	"error_count" integer,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_summary" text
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "flagged_duplicate_of_id" bigint;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_flagged_duplicate_of_id_wallet_transactions_id_fk" FOREIGN KEY ("flagged_duplicate_of_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_tx_import_batch_idx" ON "wallet_transactions" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_fingerprint_idx" ON "wallet_transactions" USING btree ("source_fingerprint");