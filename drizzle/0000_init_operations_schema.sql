CREATE TYPE "public"."priority" AS ENUM('Low', 'Normal', 'High');--> statement-breakpoint
CREATE TYPE "public"."product" AS ENUM('cashout', 'sendmoney');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('topup', 'settlement');--> statement-breakpoint
CREATE TYPE "public"."wallet_status_value" AS ENUM('Active', 'Inactive', 'Suspended');--> statement-breakpoint
CREATE TABLE "agent_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"wallet_type_id" integer,
	"account_status" text,
	"group_code" text,
	"balance" numeric(18, 2),
	"total_dp" numeric(18, 2),
	"total_wd" numeric(18, 2),
	"is_logged_in" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"agent_code" text NOT NULL,
	"leader_id" integer,
	"brand_id" integer,
	"opening_balance" numeric(18, 2),
	"sdp" numeric(18, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_cash_inhand" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer,
	"ssp_ag" numeric(18, 2),
	"ssp_ps" numeric(18, 2),
	"ess" numeric(18, 2),
	"autopay" numeric(18, 2),
	"expay" numeric(18, 2),
	"total_cih" numeric(18, 2),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_ssp_line1" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"brand_id" integer,
	"opening_balance" numeric(18, 2),
	"deposit" numeric(18, 2),
	"withdrawal" numeric(18, 2),
	"adjustment" numeric(18, 2),
	"total" numeric(18, 2),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"code" text NOT NULL,
	"display_name" text
);
--> statement-breakpoint
CREATE TABLE "cashgo_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"trend_date" date NOT NULL,
	"wallet_type" text NOT NULL,
	"quota" numeric(18, 2),
	"processed" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "dashboard_manual_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"wallet" text NOT NULL,
	"total_dp" numeric(18, 2),
	"total_wd" numeric(18, 2),
	"actual_balance" numeric(18, 2),
	"running_balance" numeric(18, 2),
	"opening_balance" numeric(18, 2),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "estimated_balance_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"upload_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"assumed_balance" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimated_balance_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cutoff_date" date NOT NULL,
	"file_name" text,
	"shop_count" integer
);
--> statement-breakpoint
CREATE TABLE "estimated_balance_wallet_totals" (
	"id" serial PRIMARY KEY NOT NULL,
	"upload_id" integer NOT NULL,
	"wallet_type" text NOT NULL,
	"total_dp" numeric(18, 2) NOT NULL,
	"total_wd" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaders" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"excluded_from_sdp" boolean DEFAULT false NOT NULL,
	CONSTRAINT "leaders_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "roster_sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transfer_queue_bundle_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_name" text NOT NULL,
	"field_value" text,
	CONSTRAINT "transfer_queue_bundle_settings_field_name_unique" UNIQUE("field_name")
);
--> statement-breakpoint
CREATE TABLE "transfer_queue_linked_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"sendmoney_wallet_name" text NOT NULL,
	"cashout_agent_id" integer,
	CONSTRAINT "transfer_queue_linked_accounts_sendmoney_wallet_name_unique" UNIQUE("sendmoney_wallet_name")
);
--> statement-breakpoint
CREATE TABLE "transfer_queue_rule_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" integer,
	"changed_field" text,
	"old_value" text,
	"new_value" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_queue_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"section" text NOT NULL,
	"row_order" integer NOT NULL,
	"metric" text NOT NULL,
	"operator" text NOT NULL,
	"value1" numeric(18, 2),
	"value2" numeric(18, 2),
	"queue_result" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'admin' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wallet_status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"field_name" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_status_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"deposit_enabled" boolean DEFAULT false NOT NULL,
	"withdrawal_enabled" boolean DEFAULT false NOT NULL,
	"priority" "priority" DEFAULT 'Normal' NOT NULL,
	"status" "wallet_status_value",
	"remark" text,
	"remark_updated_by" text,
	"remark_updated_at" timestamp with time zone,
	"main_reason" text,
	"closure_type" text,
	"affected_services" text[],
	"minimum_amount_can_take" numeric(18, 2),
	"balance_limit_override" numeric(18, 2),
	"schedule_override" text,
	CONSTRAINT "wallet_status_overrides_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"agent_id" integer NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"wallet" text,
	"occurred_on" date NOT NULL,
	"remarks" text,
	"source_row_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	CONSTRAINT "wallet_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_wallet_type_id_wallet_types_id_fk" FOREIGN KEY ("wallet_type_id") REFERENCES "public"."wallet_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_leader_id_leaders_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."leaders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_cash_inhand" ADD CONSTRAINT "brand_cash_inhand_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_ssp_line1" ADD CONSTRAINT "brand_ssp_line1_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_balance_entries" ADD CONSTRAINT "estimated_balance_entries_upload_id_estimated_balance_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."estimated_balance_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_balance_entries" ADD CONSTRAINT "estimated_balance_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_balance_wallet_totals" ADD CONSTRAINT "estimated_balance_wallet_totals_upload_id_estimated_balance_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."estimated_balance_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_queue_linked_accounts" ADD CONSTRAINT "transfer_queue_linked_accounts_cashout_agent_id_agents_id_fk" FOREIGN KEY ("cashout_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_queue_rule_history" ADD CONSTRAINT "transfer_queue_rule_history_rule_id_transfer_queue_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."transfer_queue_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_overrides" ADD CONSTRAINT "wallet_status_overrides_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_wallets_agent_id_idx" ON "agent_wallets" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_product_code_uq" ON "agents" USING btree ("product","agent_code");--> statement-breakpoint
CREATE INDEX "agents_leader_id_idx" ON "agents" USING btree ("leader_id");--> statement-breakpoint
CREATE INDEX "agents_brand_id_idx" ON "agents" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_product_code_uq" ON "brands" USING btree ("product","code");--> statement-breakpoint
CREATE UNIQUE INDEX "cashgo_daily_uq" ON "cashgo_daily" USING btree ("product","trend_date","wallet_type");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_manual_balances_uq" ON "dashboard_manual_balances" USING btree ("product","wallet");--> statement-breakpoint
CREATE INDEX "estimated_balance_entries_upload_id_idx" ON "estimated_balance_entries" USING btree ("upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimated_balance_wallet_totals_uq" ON "estimated_balance_wallet_totals" USING btree ("upload_id","wallet_type");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transfer_queue_rule_history_rule_id_idx" ON "transfer_queue_rule_history" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_queue_rules_section_row_uq" ON "transfer_queue_rules" USING btree ("section","row_order");--> statement-breakpoint
CREATE INDEX "wallet_status_history_agent_id_idx" ON "wallet_status_history" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_agent_id_idx" ON "wallet_transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_occurred_on_idx" ON "wallet_transactions" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "wallet_tx_agent_date_idx" ON "wallet_transactions" USING btree ("agent_id","occurred_on");