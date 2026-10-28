CREATE TABLE IF NOT EXISTS "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"locked" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_uq" ON "roles" USING btree ("key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_uq" ON "roles" USING btree (lower("name"));
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roles" ADD CONSTRAINT "roles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"role_id" integer NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "locked", "hidden") VALUES
	('admin', 'Admin', 'Full access, including Settings and Users & Roles. Locked.', true, false),
	('supervisor', 'Supervisor', 'Views every page and ticket; cannot edit, upload, send or settle.', false, false),
	('ops', 'OPS', 'Data entry on every page, Telegram sends, settles Agent concern tickets.', false, false),
	('acc', 'ACC', 'Views dashboards; settles Shop replacement and Adding new account tickets.', false, false),
	('leader', 'Leader', 'Raises tickets for their own shops/agents only.', false, false),
	('viewer', 'Viewer', 'Read-only dashboards. No edit, upload or send buttons.', false, false),
	('system', 'System', 'Scheduler service account (sync only). Hidden.', false, true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", v."permission" FROM (VALUES
	('supervisor', 'page.dashboard.view'),
	('supervisor', 'page.balance.view'),
	('supervisor', 'page.opening.view'),
	('supervisor', 'page.settlement.view'),
	('supervisor', 'page.topup.view'),
	('supervisor', 'page.dailyEntry.view'),
	('supervisor', 'page.transferQueue.view'),
	('supervisor', 'page.walletStatus.view'),
	('supervisor', 'page.pendingBalance.view'),
	('supervisor', 'tickets.agent_concern.view'),
	('supervisor', 'tickets.shop_replacement.view'),
	('supervisor', 'tickets.adding_new_account.view'),
	('ops', 'page.dashboard.view'),
	('ops', 'page.balance.view'),
	('ops', 'page.opening.view'),
	('ops', 'page.settlement.view'),
	('ops', 'page.topup.view'),
	('ops', 'page.dailyEntry.view'),
	('ops', 'page.transferQueue.view'),
	('ops', 'page.walletStatus.view'),
	('ops', 'page.pendingBalance.view'),
	('ops', 'page.opening.edit'),
	('ops', 'page.opening.upload'),
	('ops', 'page.opening.delete'),
	('ops', 'page.opening.bulkEdit'),
	('ops', 'page.settlement.edit'),
	('ops', 'page.settlement.upload'),
	('ops', 'page.settlement.delete'),
	('ops', 'page.settlement.bulkEdit'),
	('ops', 'page.topup.edit'),
	('ops', 'page.topup.upload'),
	('ops', 'page.topup.delete'),
	('ops', 'page.topup.bulkEdit'),
	('ops', 'page.dailyEntry.edit'),
	('ops', 'page.walletStatus.edit'),
	('ops', 'page.walletStatus.bulkEdit'),
	('ops', 'page.balance.upload'),
	('ops', 'page.dashboard.telegram'),
	('ops', 'page.pendingBalance.telegram'),
	('ops', 'tickets.agent_concern.view'),
	('ops', 'tickets.agent_concern.settle'),
	('acc', 'page.dashboard.view'),
	('acc', 'page.balance.view'),
	('acc', 'page.opening.view'),
	('acc', 'page.settlement.view'),
	('acc', 'page.topup.view'),
	('acc', 'page.transferQueue.view'),
	('acc', 'page.walletStatus.view'),
	('acc', 'page.pendingBalance.view'),
	('acc', 'tickets.shop_replacement.view'),
	('acc', 'tickets.shop_replacement.settle'),
	('acc', 'tickets.adding_new_account.view'),
	('acc', 'tickets.adding_new_account.settle'),
	('leader', 'tickets.raise'),
	('viewer', 'page.dashboard.view'),
	('viewer', 'page.balance.view'),
	('viewer', 'page.opening.view'),
	('viewer', 'page.settlement.view'),
	('viewer', 'page.topup.view'),
	('viewer', 'page.dailyEntry.view'),
	('viewer', 'page.transferQueue.view'),
	('viewer', 'page.walletStatus.view'),
	('viewer', 'page.pendingBalance.view'),
	('system', 'system.sync')
) AS v("role_key", "permission")
JOIN "roles" r ON r."key" = v."role_key"
-- Only roles with no permissions yet: re-running never undoes edits made on the Roles screen.
WHERE NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id")
ON CONFLICT DO NOTHING;
