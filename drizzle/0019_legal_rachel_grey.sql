CREATE TYPE "public"."daily_txn_rollover_status" AS ENUM('running', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "daily_txn_cashgo_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_date" date NOT NULL,
	"channel" text NOT NULL,
	"target" text,
	"process" numeric(18, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_txn_ledger_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"brand" text NOT NULL,
	"row_key" text NOT NULL,
	"business_date" date NOT NULL,
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_txn_pg_balance_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"pg_key" text NOT NULL,
	"brand" text NOT NULL,
	"business_date" date NOT NULL,
	"amount" numeric(18, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_txn_rollover_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_date" date NOT NULL,
	"status" "daily_txn_rollover_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "daily_txn_wallet_closing_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"wallet" text NOT NULL,
	"business_date" date NOT NULL,
	"amount" numeric(18, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_cashgo_entry_uq" ON "daily_txn_cashgo_entry" USING btree ("business_date","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_ledger_entry_uq" ON "daily_txn_ledger_entry" USING btree ("ledger_id","brand","row_key","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_pg_balance_entry_uq" ON "daily_txn_pg_balance_entry" USING btree ("pg_key","brand","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_rollover_runs_business_date_uq" ON "daily_txn_rollover_runs" USING btree ("business_date") WHERE "daily_txn_rollover_runs"."status" in ('running', 'success');--> statement-breakpoint
CREATE UNIQUE INDEX "daily_txn_wallet_closing_entry_uq" ON "daily_txn_wallet_closing_entry" USING btree ("ledger_id","wallet","business_date");