import {
  pgTable,
  pgEnum,
  serial,
  bigserial,
  bigint,
  integer,
  text,
  numeric,
  boolean,
  timestamp,
  date,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Schema for the centralized operations database — see
// docs/DATABASE_MIGRATION_PLAN.md for the full analysis/reasoning behind
// each table. This file is the design only: no migration has been generated
// or applied yet.
//
// `product` shows up on most tables because Cashout and Send Money are
// currently two fully parallel Google Sheets structures; here they share
// one set of tables discriminated by this column instead of being
// duplicated schemas (see migration plan, "duplicate data" section).
//
// Ticketing tables are intentionally NOT included yet, per explicit
// instruction — `agents` and `users` below are shaped so ticketing tables
// can reference them later without any change to what's here.
// ---------------------------------------------------------------------------

export const productEnum = pgEnum('product', ['cashout', 'sendmoney']);
export const transactionTypeEnum = pgEnum('transaction_type', ['topup', 'settlement']);
export const priorityEnum = pgEnum('priority', ['Low', 'Normal', 'High']);
export const walletStatusEnum = pgEnum('wallet_status_value', ['Active', 'Inactive', 'Suspended']);

// ---------------------------------------------------------------------------
// Reference / lookup tables
// ---------------------------------------------------------------------------

export const brands = pgTable(
  'brands',
  {
    id: serial('id').primaryKey(),
    product: productEnum('product').notNull(),
    code: text('code').notNull(), // 'M1','K1','SH', etc.
    displayName: text('display_name'),
  },
  (t) => [uniqueIndex('brands_product_code_uq').on(t.product, t.code)]
);

export const leaders = pgTable('leaders', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  // Replaces the hardcoded EXCLUDED_SDP_LEADERS array in app code — moving
  // this from code to data was flagged as a real behavior change in the
  // migration plan (worth confirming with the business), not a neutral
  // refactor.
  excludedFromSdp: boolean('excluded_from_sdp').notNull().default(false),
});

export const walletTypes = pgTable('wallet_types', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // 'BKASH','NAGAD','ROCKET','UPAY'
});

// ---------------------------------------------------------------------------
// Auth (foundational — not sheet-derived, needed regardless of ticketing)
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)]
);

// ---------------------------------------------------------------------------
// Core roster (current-state)
// ---------------------------------------------------------------------------

export const agents = pgTable(
  'agents',
  {
    id: serial('id').primaryKey(),
    product: productEnum('product').notNull(),
    // The canonical bare code, post stripBrandSuffix normalization — see
    // migration plan risk #1. This is the single join key every other
    // table below hangs off, replacing today's string-matching-across-
    // sheets convention.
    agentCode: text('agent_code').notNull(),
    leaderId: integer('leader_id').references(() => leaders.id),
    brandId: integer('brand_id').references(() => brands.id),
    openingBalance: numeric('opening_balance', { precision: 18, scale: 2 }),
    sdp: numeric('sdp', { precision: 18, scale: 2 }),
    // Opening Balance's daily-upload feature (see importOpeningFile in
    // importService.ts): isActive backs the "Mark Inactive" action on a shop
    // missing from a day's file (store + badge only this pass — no other
    // page's calculations read this yet). lastImportMatchedAt is set
    // whenever a row in an uploaded file resolves to this agent (matched or
    // freshly inserted) — deliberately separate from updatedAt, which also
    // moves on a plain manual Edit; "last successful match" needs to mean
    // specifically "last time an upload confirmed this shop," not any edit.
    isActive: boolean('is_active').notNull().default(true),
    lastImportMatchedAt: timestamp('last_import_matched_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_product_code_uq').on(t.product, t.agentCode),
    index('agents_leader_id_idx').on(t.leaderId),
    index('agents_brand_id_idx').on(t.brandId),
  ]
);

export const agentWallets = pgTable(
  'agent_wallets',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id').notNull().references(() => agents.id),
    walletTypeId: integer('wallet_type_id').references(() => walletTypes.id),
    accountStatus: text('account_status'), // populated from the raw "Group" cell (no real "Account Status" input column exists — see balanceLimitParser.ts), feeds live wallet-status derivation
    groupCode: text('group_code'), // raw "Group" column (feeds brand resolution today)
    balance: numeric('balance', { precision: 18, scale: 2 }),
    totalDp: numeric('total_dp', { precision: 18, scale: 2 }),
    totalWd: numeric('total_wd', { precision: 18, scale: 2 }),
    isLoggedIn: boolean('is_logged_in').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_wallets_agent_id_idx').on(t.agentId)]
);

// ---------------------------------------------------------------------------
// Transaction ledger (historical, append-only)
// ---------------------------------------------------------------------------

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    product: productEnum('product').notNull(),
    agentId: integer('agent_id').notNull().references(() => agents.id),
    // Normalized 'topup' | 'settlement' — NOT the raw sheet Type label.
    // Cashout and Send Money use opposite label conventions for the same
    // concepts (migration plan risk #3); this column must always mean the
    // same thing regardless of product.
    transactionType: transactionTypeEnum('transaction_type').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(), // always positive; sign implied by transactionType
    wallet: text('wallet'), // Bkash/Nagad/Rocket/Upay
    occurredOn: date('occurred_on').notNull(),
    // Originally Settlement-only (Cashout's own free-text Remarks column
    // from the old, now-disabled Sheets-sync pipeline). Since the real
    // upload/edit pipeline (importService.ts, transactionActionsService.ts)
    // became the only way new rows get written, this is a generic "6th
    // descriptive field" slot for BOTH transaction types: Settlement's
    // free-text Remarks, or Top Up's closed-set Type (see
    // topupOptions.ts's TOPUP_TYPE_OPTIONS) — which one it holds is implied
    // by this row's own transactionType. Historical rows from before that
    // fix are NULL here regardless of type; transactionPageService.ts's
    // getTopUpRows falls back to a fixed per-product label for those.
    remarks: text('remarks'),
    // Phase 10 — transaction-level Brand. Nullable: shops are shared across
    // brands now, so agents.brand_id can no longer stand in for "which
    // brand does this transaction belong to" (see balanceEngine.ts's own
    // resolveBrand — that's a per-agent, current-state resolution, not a
    // per-transaction fact). Every historical row imported before this
    // column existed (Sheets sync + the handful of early manual uploads)
    // has no authoritative Brand and is deliberately left NULL forever —
    // never backfilled from agent name parsing or agents.brand_id, per
    // explicit instruction. Only rows uploaded through the Brand-required
    // flow (importSettlementFile/importTopUpFile, post this column) ever
    // populate it. SSP Line 1's new calculation filters on
    // `brand_id IS NOT NULL`, which is what actually implements the
    // "fresh start" boundary — no separate cutoff-date field needed.
    brandId: integer('brand_id').references(() => brands.id),
    sourceRowRef: text('source_row_ref'), // traceability back to the originating sheet row during migration
    // --- Added for the local Postgres-import foundation (server-side XLSX
    // import pipeline) — nullable so every row migrated from Sheets before
    // this addition stays valid with no backfill required. Only rows
    // inserted via the new import service populate these.
    importBatchId: integer('import_batch_id').references(() => importBatches.id),
    // Deterministic dedup key — SHA-256 of (product, transactionType,
    // agentId, wallet, amount, occurredOn), see importService.ts. Indexed,
    // NOT unique: per explicit instruction, a matching fingerprint must
    // flag a row for review, never silently reject or merge it — a real
    // unique constraint would make that impossible (the second insert
    // would fail outright instead of being preserved-and-flagged).
    sourceFingerprint: text('source_fingerprint'),
    // Set when this row's fingerprint matched an already-existing row at
    // import time. Points at the EARLIER row (never the other direction),
    // so "flagged, unresolved duplicates" is a simple `WHERE
    // flagged_duplicate_of_id IS NOT NULL` query. Both rows are always
    // preserved — this column marks a review need, it never causes a
    // delete/merge.
    flaggedDuplicateOfId: bigint('flagged_duplicate_of_id', { mode: 'number' }).references((): AnyPgColumn => walletTransactions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_tx_agent_id_idx').on(t.agentId),
    index('wallet_tx_occurred_on_idx').on(t.occurredOn),
    index('wallet_tx_agent_date_idx').on(t.agentId, t.occurredOn),
    index('wallet_tx_import_batch_idx').on(t.importBatchId),
    index('wallet_tx_fingerprint_idx').on(t.sourceFingerprint),
    index('wallet_tx_brand_id_idx').on(t.brandId),
  ]
);

// ---------------------------------------------------------------------------
// Import batch tracking (local Postgres-import foundation) — one row per
// XLSX upload processed by the new server-side import service
// (app/lib/services/importService.ts). Every wallet_transactions row
// inserted by that service links back here via import_batch_id, so a whole
// upload's effect can always be traced, audited, or reported on — history
// is never destroyed (rows are never deleted when a batch is superseded).
// ---------------------------------------------------------------------------

// Phase 8b — 'balancelimit' added for the new Balance Limit upload
// (app/lib/services/balanceLimitService.ts). Reuses this same import_batches
// history/timestamp infrastructure rather than inventing a parallel one, per
// explicit instruction — additive enum value only, the 3 existing values are
// untouched.
export const importTypeEnum = pgEnum('import_type', ['settlement', 'topup', 'opening', 'balancelimit']);
export const importStatusEnum = pgEnum('import_status', ['pending', 'processing', 'completed', 'failed']);

export const importBatches = pgTable('import_batches', {
  id: serial('id').primaryKey(),
  product: productEnum('product').notNull(),
  importType: importTypeEnum('import_type').notNull(),
  fileName: text('file_name'),
  uploadedBy: text('uploaded_by'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  rowCount: integer('row_count'),
  validCount: integer('valid_count'),
  duplicateCount: integer('duplicate_count'),
  errorCount: integer('error_count'),
  status: importStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // JSON-stringified array of { row, field, issue } — same shape as the
  // existing client-side ValidationEntry[] (settlementValidation.ts), kept
  // as text rather than a new jsonb column type to match this schema's
  // existing convention of storing structured-but-secondary data as text
  // (see MigrationLogger's own rejection logging pattern).
  errorSummary: text('error_summary'),
});

// ---------------------------------------------------------------------------
// Wallet Status (current-state + audit history)
// ---------------------------------------------------------------------------

// wallet_id is nullable and product-dependent: Cashout's real row identity
// is per-WALLET (a shop's Bkash/Nagad/Rocket/UPay wallets can carry
// different remarks — confirmed via real data: of the 2,251 real,
// agent_wallets-linked Cashout agents, 1,210 (54%) have 2+ wallets), while
// Send Money's is per-SHOP (its own Balance Limit model is "every shop
// solo" — 27 of 11,273 Send Money agents have more than one wallet, the
// rare exception not the rule). A single blanket `unique(agent_id)` can
// only ever represent one of these two shapes correctly; forcing Cashout's
// per-wallet remarks through it is exactly what produced the real bug this
// migration fixes (see the two partial indexes below, and
// walletStatusConfigService.ts's own resolveTarget()).
export const walletStatusOverrides = pgTable(
  'wallet_status_overrides',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id').notNull().references(() => agents.id),
    walletId: integer('wallet_id').references(() => agentWallets.id),
    depositEnabled: boolean('deposit_enabled').notNull().default(false),
    withdrawalEnabled: boolean('withdrawal_enabled').notNull().default(false),
    priority: priorityEnum('priority').notNull().default('Normal'),
    status: walletStatusEnum('status'), // null = unset, a real displayable "—" state (not a default to fall back through)
    remark: text('remark'),
    remarkUpdatedBy: text('remark_updated_by'),
    remarkUpdatedAt: timestamp('remark_updated_at', { withTimezone: true }),
    mainReason: text('main_reason'),
    closureType: text('closure_type'),
    affectedServices: text('affected_services').array(),
    minimumAmountCanTake: numeric('minimum_amount_can_take', { precision: 18, scale: 2 }),
    balanceLimitOverride: numeric('balance_limit_override', { precision: 18, scale: 2 }),
    scheduleOverride: text('schedule_override'),
  },
  (t) => [
    // Cashout: at most one row per real wallet.
    uniqueIndex('wallet_status_overrides_wallet_uq').on(t.walletId).where(sql`${t.walletId} IS NOT NULL`),
    // Send Money (and any future no-wallet-granularity product): at most
    // one row per agent, only enforced when this row isn't already
    // wallet-scoped above.
    uniqueIndex('wallet_status_overrides_agent_only_uq').on(t.agentId).where(sql`${t.walletId} IS NULL`),
    index('wallet_status_overrides_agent_id_idx').on(t.agentId),
  ]
);

export const walletStatusHistory = pgTable(
  'wallet_status_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    agentId: integer('agent_id').notNull().references(() => agents.id),
    // Same nullable, product-dependent meaning as walletStatusOverrides.walletId
    // above — set for Cashout (per-wallet history), null for Send Money
    // (per-shop history).
    walletId: integer('wallet_id').references(() => agentWallets.id),
    fieldName: text('field_name').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_status_history_agent_id_idx').on(t.agentId),
    index('wallet_status_history_wallet_id_idx').on(t.walletId),
  ]
);

// ---------------------------------------------------------------------------
// Transfer Queue Settings
//
// is_live seed values, confirmed against app/lib/transferQueueSettings.ts's
// own RuleSection comment (which sections resolveCashoutCorrectGroup/
// resolveSendMoneyCorrectGroup/shouldExcludeBdWallet actually read):
//   true  (live, real production code depends on these):
//     cashout_day, cashout_extended, cashout_247, sendmoney_247, sendmoney_bd
//   false (admin-only draft — nothing reads these yet):
//     cashout_sh_day, cashout_sh_early_extended, cashout_sh_extended,
//     cashout_sh_247, sendmoney_sh_247, sendmoney_sh_day
// Default stays `false` below so a migration script must explicitly flip
// the 5 live sections on rather than accidentally trusting a draft one.
// ---------------------------------------------------------------------------

export const transferQueueRules = pgTable(
  'transfer_queue_rules',
  {
    id: serial('id').primaryKey(),
    section: text('section').notNull(),
    rowOrder: integer('row_order').notNull(),
    metric: text('metric').notNull(),
    operator: text('operator').notNull(),
    value1: numeric('value1', { precision: 18, scale: 2 }),
    value2: numeric('value2', { precision: 18, scale: 2 }),
    queueResult: text('queue_result'),
    enabled: boolean('enabled').notNull().default(true),
    // Explicit: is this section wired into real Transfer Queue code, or
    // still an admin-only draft? The current sheet mixes both in one table
    // with no such flag — migration plan risk #9.
    isLive: boolean('is_live').notNull().default(false),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transfer_queue_rules_section_row_uq').on(t.section, t.rowOrder)]
);

export const transferQueueRuleHistory = pgTable(
  'transfer_queue_rule_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ruleId: integer('rule_id').references(() => transferQueueRules.id),
    changedField: text('changed_field'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transfer_queue_rule_history_rule_id_idx').on(t.ruleId)]
);

export const transferQueueBundleSettings = pgTable('transfer_queue_bundle_settings', {
  id: serial('id').primaryKey(),
  fieldName: text('field_name').notNull().unique(), // 'Excluded Brands' | 'Bundle Enabled' | 'Auto Grouping'
  fieldValue: text('field_value'),
});

export const transferQueueLinkedAccounts = pgTable('transfer_queue_linked_accounts', {
  id: serial('id').primaryKey(),
  sendmoneyWalletName: text('sendmoney_wallet_name').notNull().unique(),
  cashoutAgentId: integer('cashout_agent_id').references(() => agents.id),
});

// Minimal, dedicated table for readMetaConfig()'s real shape (a singleton
// {mode, version}, not a growing key-value list like bundle settings above)
// — "Transfer Queue Configurations!P2:S3" in the sheet. `mode` is the
// production/configuration kill-switch: 'production' means Transfer Queue
// code ignores the sheet entirely and always evaluates against
// DEFAULT_RULES; ticketing/future consumers must respect that same
// meaning, not just read `mode` as a label.
export const transferQueueMetaConfig = pgTable('transfer_queue_meta_config', {
  id: serial('id').primaryKey(),
  mode: text('mode').notNull().default('configuration'), // 'production' | 'configuration'
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Sync monitoring — one row per scheduled/manual sync invocation (see
// scripts/migrate-data.ts's runFastSync()/runSlowSync(), triggered by
// app/api/admin/sync-postgres/route.ts). A 'running' row also doubles as
// the per-group overlap guard: a new run of the same group checks for an
// existing 'running' row before starting, rather than relying on an
// in-memory flag that wouldn't survive a process restart or (if this ever
// runs under PM2 cluster mode) a different worker.
// ---------------------------------------------------------------------------

export const syncRunStatusEnum = pgEnum('sync_run_status', ['running', 'success', 'failure']);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: serial('id').primaryKey(),
    syncGroup: text('sync_group').notNull(), // 'fast' | 'slow'
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncRunStatusEnum('status').notNull().default('running'),
    insertedTotal: integer('inserted_total'),
    updatedTotal: integer('updated_total'),
    skippedTotal: integer('skipped_total'),
    rejectedTotal: integer('rejected_total'),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('sync_runs_group_started_idx').on(t.syncGroup, t.startedAt),
    // Makes the overlap guard atomic at the database level: at most one
    // 'running' row can exist per sync_group at a time, enforced by
    // Postgres itself. A plain "SELECT for running rows, then INSERT if
    // none found" (the first version of this) has a race window between
    // the two statements — two concurrent requests can both pass the
    // SELECT before either INSERTs, and both proceed (confirmed live: two
    // concurrent FAST requests both returned 200 and both wrote data).
    // With this index, the second concurrent INSERT fails with a real
    // unique-violation error instead, which runGroupSync() catches.
    uniqueIndex('sync_runs_one_running_per_group_uq')
      .on(t.syncGroup)
      .where(sql`${t.status} = 'running'`),
  ]
);

// ---------------------------------------------------------------------------
// Dashboard / SSP Overview manual snapshots
// ---------------------------------------------------------------------------

// Verified against app/page.tsx's parseSheetBlock(): "Dashboard Overview" is
// 8 columns, ONE ROW PER WALLET (TOTAL/BKASH/NAGAD/ROCKET/UPAY), not one row
// per product as originally assumed. Only 6 of those 8 columns are stored
// here — the sheet's own "BD-Transfer IN"/"STLM & BD Transfer Out" columns
// are confirmed (by comment in parseSheetBlock/buildCardData) to always be
// seeded at 0 and never trusted by the app; Top Up/Settlement are always
// live-computed from wallet_transactions instead. Migrating those 2 columns
// would just copy meaningless zeros, so they're intentionally omitted here.
export const dashboardManualBalances = pgTable(
  'dashboard_manual_balances',
  {
    id: serial('id').primaryKey(),
    product: productEnum('product').notNull(),
    wallet: text('wallet').notNull(), // 'TOTAL' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'UPAY'
    totalDp: numeric('total_dp', { precision: 18, scale: 2 }),
    totalWd: numeric('total_wd', { precision: 18, scale: 2 }),
    actualBalance: numeric('actual_balance', { precision: 18, scale: 2 }), // sheet's "Balance Inside Wallet"
    runningBalance: numeric('running_balance', { precision: 18, scale: 2 }),
    openingBalance: numeric('opening_balance', { precision: 18, scale: 2 }),
    // Added even though today's sheet only ever holds a "current" value —
    // retrofitting history later is expensive, this column is cheap now.
    // Still an open question (migration plan risk #10) whether historical
    // rows should ever accumulate here, or this stays latest-value-only.
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => [uniqueIndex('dashboard_manual_balances_uq').on(t.product, t.wallet)]
);

export const brandCashInhand = pgTable('brand_cash_inhand', {
  id: serial('id').primaryKey(),
  brandId: integer('brand_id').references(() => brands.id),
  sspAg: numeric('ssp_ag', { precision: 18, scale: 2 }),
  sspPs: numeric('ssp_ps', { precision: 18, scale: 2 }),
  ess: numeric('ess', { precision: 18, scale: 2 }),
  autopay: numeric('autopay', { precision: 18, scale: 2 }),
  expay: numeric('expay', { precision: 18, scale: 2 }),
  totalCih: numeric('total_cih', { precision: 18, scale: 2 }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const brandSspLine1 = pgTable('brand_ssp_line1', {
  id: serial('id').primaryKey(),
  product: productEnum('product').notNull(),
  brandId: integer('brand_id').references(() => brands.id),
  openingBalance: numeric('opening_balance', { precision: 18, scale: 2 }),
  deposit: numeric('deposit', { precision: 18, scale: 2 }),
  withdrawal: numeric('withdrawal', { precision: 18, scale: 2 }),
  adjustment: numeric('adjustment', { precision: 18, scale: 2 }),
  total: numeric('total', { precision: 18, scale: 2 }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

// Verified against app/page.tsx's parseTodayCashGo(): the "CashGo" sheet is
// one row per DAY with 5 meaningful columns — Date, Bkash Quota, Nagad
// Quota, Bkash Processed, Nagad Processed. That's TWO metrics per wallet
// per day (quota and processed), not one generic amount as first assumed —
// corrected below. Also confirmed: Send Money has NO equivalent sheet: its
// Bundle Transfer Trend is computed live from wallet_transactions, so this
// table is Cashout-only in practice (product kept for schema uniformity,
// not because Send Money populates it).
export const cashgoDaily = pgTable(
  'cashgo_daily',
  {
    id: serial('id').primaryKey(),
    product: productEnum('product').notNull(),
    trendDate: date('trend_date').notNull(),
    walletType: text('wallet_type').notNull(), // 'BKASH' | 'NAGAD' — the only two CashGo tracks
    quota: numeric('quota', { precision: 18, scale: 2 }),
    processed: numeric('processed', { precision: 18, scale: 2 }),
  },
  (t) => [uniqueIndex('cashgo_daily_uq').on(t.product, t.trendDate, t.walletType)]
);

// ---------------------------------------------------------------------------
// Estimated Balance uploads (current-state, with upload history)
// ---------------------------------------------------------------------------

export const estimatedBalanceUploads = pgTable('estimated_balance_uploads', {
  id: serial('id').primaryKey(),
  product: productEnum('product').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  cutoffDate: date('cutoff_date').notNull(),
  fileName: text('file_name'),
  // Confirmed real (writeCashoutEstimatedOpening/writeSendMoneyEstimatedOpening
  // both return + persist this to the sheet's own Import Log block).
  shopCount: integer('shop_count'),
});

// assumedBalance already has that upload's Top Up/Settlement baked in at
// write time (see app/lib/estimatedOpening.ts's own extensive comment on
// why that's safe) — it is NOT a raw balance that needs further adjustment
// at read time.
export const estimatedBalanceEntries = pgTable(
  'estimated_balance_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uploadId: integer('upload_id').notNull().references(() => estimatedBalanceUploads.id),
    agentId: integer('agent_id').notNull().references(() => agents.id),
    assumedBalance: numeric('assumed_balance', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [index('estimated_balance_entries_upload_id_idx').on(t.uploadId)]
);

// NEW — was entirely missing from the first draft. Confirmed via
// aggregateByWalletType() in app/lib/estimatedOpening.ts: every upload also
// produces a per-wallet-type (Bkash/Nagad/Rocket/Upay) Total DP/Total WD
// breakdown, feeding the Wallet Breakdown's Assumed Running Balance on the
// Dashboard — a completely separate figure from assumedBalance above, not
// derivable from it.
export const estimatedBalanceWalletTotals = pgTable(
  'estimated_balance_wallet_totals',
  {
    id: serial('id').primaryKey(),
    uploadId: integer('upload_id').notNull().references(() => estimatedBalanceUploads.id),
    walletType: text('wallet_type').notNull(), // 'BKASH' | 'NAGAD' | 'ROCKET' | 'UPAY'
    totalDp: numeric('total_dp', { precision: 18, scale: 2 }).notNull(),
    totalWd: numeric('total_wd', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [uniqueIndex('estimated_balance_wallet_totals_uq').on(t.uploadId, t.walletType)]
);

// NEW — was entirely missing. Replaces the "Opening AG" col G/I 'REPORT LAST
// UPDATE' text card. That card is a single roster-wide timestamp (when the
// whole Opening roster was last refreshed), read today in at least 3 places
// (Settlement/Top Up cutoff filtering, both Estimated Opening formulas) —
// once Opening AG becomes a real table, this needs its own real source
// rather than being re-derived from agents.updated_at, which can be bumped
// by unrelated per-agent operations and wouldn't reliably represent "the
// whole roster's last refresh." See migration plan item 5 for the
// recommendation this table implements.
export const rosterSyncLog = pgTable('roster_sync_log', {
  id: serial('id').primaryKey(),
  product: productEnum('product').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Relations (query ergonomics only — no schema effect)
// ---------------------------------------------------------------------------

export const agentsRelations = relations(agents, ({ one, many }) => ({
  leader: one(leaders, { fields: [agents.leaderId], references: [leaders.id] }),
  brand: one(brands, { fields: [agents.brandId], references: [brands.id] }),
  wallets: many(agentWallets),
  transactions: many(walletTransactions),
  statusOverride: one(walletStatusOverrides, { fields: [agents.id], references: [walletStatusOverrides.agentId] }),
}));

export const agentWalletsRelations = relations(agentWallets, ({ one }) => ({
  agent: one(agents, { fields: [agentWallets.agentId], references: [agents.id] }),
  walletType: one(walletTypes, { fields: [agentWallets.walletTypeId], references: [walletTypes.id] }),
}));

export const walletTransactionsRelations = relations(walletTransactions, ({ one }) => ({
  agent: one(agents, { fields: [walletTransactions.agentId], references: [agents.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const estimatedBalanceUploadsRelations = relations(estimatedBalanceUploads, ({ many }) => ({
  entries: many(estimatedBalanceEntries),
  walletTotals: many(estimatedBalanceWalletTotals),
}));

export const estimatedBalanceEntriesRelations = relations(estimatedBalanceEntries, ({ one }) => ({
  upload: one(estimatedBalanceUploads, { fields: [estimatedBalanceEntries.uploadId], references: [estimatedBalanceUploads.id] }),
  agent: one(agents, { fields: [estimatedBalanceEntries.agentId], references: [agents.id] }),
}));
