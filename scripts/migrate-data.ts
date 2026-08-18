// Google Sheets -> PostgreSQL data migration.
//
// READ-ONLY against Google Sheets (never writes back — the existing sheets
// are the dashboard's live data source and stay untouched). All writes go
// to Postgres only, and are idempotent: re-running this script is always
// safe and never creates duplicates. No dashboard PAGE reads from this —
// the one deliberate exception is app/api/admin/sync-postgres/route.ts,
// which calls runFullSync() (this file's orchestration, minus main()'s own
// process.exit) on a schedule to keep Postgres from drifting indefinitely
// stale versus Sheets. That route is a write-to-Postgres sync trigger, not
// a dashboard read path — it doesn't change what any page displays.
//
// Run directly with:  npx tsx scripts/migrate-data.ts
// (main() below is CLI-only — not run automatically by anything itself.)
//
// Idempotency strategy per table (see docs/DATABASE_MIGRATION_PLAN.md for
// the full source-to-table mapping this implements):
//   - Tables with a real unique constraint (agents, wallet_status_overrides,
//     transfer_queue_rules/bundle_settings/linked_accounts,
//     dashboard_manual_balances, cashgo_daily, estimated_balance_wallet_totals,
//     brands/leaders/wallet_types): real INSERT ... ON CONFLICT upsert.
//   - agent_wallets, brand_cash_inhand, brand_ssp_line1: current-state
//     snapshots with no natural per-row unique key -> DELETE + INSERT
//     ("replace"), transactional, always converges to the sheet's current
//     state.
//   - wallet_transactions: historical/append-only, no DB-level unique
//     constraint (kept in scope as data-migration only, not a schema
//     change) -> existing source_row_ref values are fetched first and
//     diffed against in application code before insert.
//   - transfer_queue_rule_history, roster_sync_log: small, deduped in
//     application code against existing rows before insert.
//   - estimated_balance_uploads (+ its children): skipped entirely if an
//     upload with the same (product, uploaded_at) already exists — the
//     sheet only ever holds its single latest upload, so this is what
//     makes re-runs not create a duplicate "upload event."

import { eq, and, inArray, desc } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { fetchRange, fetchBalanceLimitRows } from '../app/lib/googleSheets';
import {
  readCashoutWalletStatus,
  readSendMoneyWalletStatus,
  readCashoutWalletRemarks,
  readSendMoneyWalletRemarks,
  readCashoutWalletOverrides,
  readSendMoneyWalletOverrides,
  mergeWalletStatusRemarksAndOverrides,
} from '../app/lib/walletStatus';
import {
  readTransferQueueRules,
  readBundleConfig,
  readLinkedCashoutAccounts,
  readMetaConfig,
  type RuleRow,
} from '../app/lib/transferQueueSettings';
// Reuses the exact same key-resolution (Cashout per-wallet, Send Money
// per-shop) and upsert logic the live write routes use — a second,
// independent implementation of this mapping is exactly what produced the
// original bug (a flat agentCode lookup silently mis-keyed 207 of 208
// Cashout rows to orphaned "shadow" agents whose agentCode already carried
// a wallet suffix, see walletStatusConfigService.ts's own header comment).
import { resolveTarget as resolveWalletStatusTarget, selectCurrentRow as selectCurrentWalletStatusRow, upsertRow as upsertWalletStatusOverridesRow } from '../app/lib/services/walletStatusConfigService';
// Real, shared Manila-timezone-safe date helpers — reused rather than
// re-implemented. This module's own top comment documents a real incident
// (a 2AM Manila upload logged as "6PM the previous day") caused by exactly
// the runtime-local-timezone mistake this migration script must not repeat.
import { manilaFields } from '../app/lib/businessDate';
// The dashboard's REAL brand-resolution logic (pure, no framework deps) —
// reused directly rather than re-implemented, so Postgres brand assignments
// are byte-identical to what app/agentbal + app/sendmoney/balances already
// compute. Traced call sites confirmed the exact config each product uses
// (see the CASHOUT_BRAND_CONFIG/SENDMONEY_BRAND_CONFIG below).
import { resolveBrand, type BrandResolutionConfig } from '../app/lib/balanceEngine';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '../app/lib/transferQueueCount';
// Estimated Opening's Postgres-sync logic (MigrationLogger, cleanText,
// parseUploadTimestamp, fetchRosterCutoffDate, importEstimatedOpening) now
// lives in one shared module so this script and the live Opening upload
// API routes (app/api/opening, app/api/sendmoney/opening) call the exact
// same code — moved there unchanged, not duplicated.
import {
  MigrationLogger,
  cleanText,
  parseUploadTimestamp,
  fetchRosterCutoffDate,
  importEstimatedOpening,
} from '../app/lib/db/sync/estimatedOpeningSync';

type Product = 'cashout' | 'sendmoney';
const db = getDb();

// Verified against app/agentbal/page.tsx's own resolveBrand() call site:
// { brandPriority: BRAND_PRIORITY, brandCodes: BRAND_CODES } — no
// skipGroups override (uses balanceEngine's own DEFAULT_SKIP_GROUPS), no
// validateComputedBrand (defaults falsy — Cashout trusts any non-'−' result).
const CASHOUT_BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const CASHOUT_BRAND_CONFIG: BrandResolutionConfig = {
  brandPriority: CASHOUT_BRAND_PRIORITY,
  brandCodes: CASHOUT_BRAND_CODES,
};

// Verified against app/sendmoney/balances/page.tsx's own resolveBrand()
// call site: Cashout's own lists + 'SH' appended, plus
// validateComputedBrand: true (Send Money additionally validates the
// computed code against brandCodes before trusting it).
const SENDMONEY_BRAND_CONFIG: BrandResolutionConfig = {
  brandPriority: [...CASHOUT_BRAND_PRIORITY, 'SH'],
  brandCodes: [...CASHOUT_BRAND_CODES, 'SH'],
  validateComputedBrand: true,
};

// ---------------------------------------------------------------------------
// Logging — every table's inserted/updated/skipped/rejected counts, and a
// full list of rejected rows with reasons (never silently discarded).
// MigrationLogger itself now lives in app/lib/db/sync/estimatedOpeningSync
// (imported above) so this script and the live Opening upload routes share
// one implementation.
// ---------------------------------------------------------------------------

// `log` is called directly by every import function below (log.inserted(),
// log.rejected(), etc.) via this module-level binding — that was fine when
// the only caller was a single one-shot CLI process, but the scheduled-sync
// API route can have multiple runGroupSync() calls active in the same
// long-lived process at once (same-group races, or FAST/SLOW running
// concurrently by design). A single shared MigrationLogger instance can't
// tell those calls' counts apart — confirmed live: two concurrent FAST
// runs each reported roughly double the real per-run totals.
//
// Fix: `log` delegates every call to whichever MigrationLogger is active
// for the CURRENT async call chain (via AsyncLocalStorage, set by
// runGroupSync() below), falling back to one shared instance outside any
// run (the CLI path — main() calls runFullSync() directly, never through
// runGroupSync(), so it keeps today's exact single-logger behavior). No
// import function's own `log.X(...)` call sites needed to change.
import { AsyncLocalStorage } from 'node:async_hooks';
const loggerContext = new AsyncLocalStorage<MigrationLogger>();
const cliLogger = new MigrationLogger();
class ContextualMigrationLogger extends MigrationLogger {
  private current(): MigrationLogger {
    return loggerContext.getStore() ?? cliLogger;
  }
  inserted(table: string, n = 1) { this.current().inserted(table, n); }
  updated(table: string, n = 1) { this.current().updated(table, n); }
  skipped(table: string, n = 1) { this.current().skipped(table, n); }
  rejected(table: string, reason: string, raw: unknown) { this.current().rejected(table, reason, raw); }
  warn(table: string, reason: string, raw: unknown) { this.current().warn(table, reason, raw); }
  report() { this.current().report(); }
  getSummary() { return this.current().getSummary(); }
  getTotals() { return this.current().getTotals(); }
  reset() { this.current().reset(); }
}
export const log: MigrationLogger = new ContextualMigrationLogger();

// ---------------------------------------------------------------------------
// Shared parsing helpers — deliberately NOT reusing the app's own rawVal()
// (its "blank becomes '-' (truthy)" behavior is a documented footgun that's
// already caused real bugs elsewhere in this app). NULL means NULL here.
// cleanText itself now lives in the shared sync module (imported above).
// ---------------------------------------------------------------------------

function cleanNumber(val: unknown): number | null {
  const cleaned = cleanText(val).replace(/,/g, '');
  if (!cleaned || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function isRosterInvalid(name: string): boolean {
  return !name || name === '-' || name.toUpperCase() === 'OLD';
}

// Matches app/agentbal/page.tsx's own BRAND_CODES — used only to strip a
// trailing "-<brand>" suffix some STLM+TOPUP "To Agent" values carry.
const BRAND_SUFFIX_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  if (parts.length >= 2 && BRAND_SUFFIX_CODES.includes(last)) return parts.slice(0, -1).join('-');
  return name;
}

// "M/D/YYYY" (STLM+TOPUP) -> "YYYY-MM-DD"
function parseSlashDate(raw: string): string | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "June 1" (CashGo, no year — assumes current year, same as the app's own
// parseCashGoDate convention) -> "YYYY-MM-DD"
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
// FIXED: originally used `new Date().getFullYear()` (the runtime's own
// local year) — the exact mistake app/lib/businessDate.ts's top comment
// warns about (a Vercel/UTC runtime's local year can genuinely differ from
// Manila's around New Year's, and its local *day* differs from Manila's
// far more often than that). Now sourced from manilaFields(), matching
// app/page.tsx's own real parseCashGoDate() exactly. Builds the "YYYY-MM-DD"
// string directly from components (no Date-object round trip) since this
// feeds a plain `date` column with no time part — safe as-is.
function parseCashGoDate(raw: string): string | null {
  const match = raw.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIdx = MONTH_NAMES.indexOf(match[1]);
  if (monthIdx === -1) return null;
  const day = parseInt(match[2], 10);
  const { year } = manilaFields(new Date());
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// parseUploadTimestamp ("MM/DD/YYYY HH:MM AM/PM", Estimated Opening's "Last
// Updated:" cell) now lives in the shared sync module (imported above), so
// this script and the live Opening upload routes share one implementation.

// parseCardCutoffDate ("Month Day - H:MM AM/PM" card, Opening AG col G/I) is
// used inside fetchRosterCutoffDate(), which now lives in the shared sync
// module (imported above) along with the businessDate.ts import it needs.

// ---------------------------------------------------------------------------
// Reference data: wallet_types (fixed, pre-seeded), leaders + brands
// (get-or-create as encountered — no dedicated source sheet of their own).
// ---------------------------------------------------------------------------

const WALLET_TYPE_CODES = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];
const walletTypeIdByCode = new Map<string, number>();

// Bank column ("SSP AG BalanceLimit" / "SSP PS BalanceLimit" col 4) is the
// real, accurate wallet-type source for BOTH products — confirmed against
// live data. Cashout's values (BKASH/NAGAD/ROCKET/UPAY) need no
// transformation. Send Money's carry a trailing "C" (BKASHC/NAGADC/
// ROCKETC/UPAYC) that must be stripped before matching WALLET_TYPE_CODES —
// not a different source, just a per-product suffix convention on the same
// column.
function resolveWalletTypeCode(product: Product, rawBank: string): string {
  const upper = cleanText(rawBank).toUpperCase();
  return product === 'sendmoney' ? upper.replace(/C$/, '') : upper;
}
const leaderIdByName = new Map<string, number>();
const brandIdByProductCode = new Map<string, number>(); // key: `${product}:${code}`

export async function seedWalletTypes() {
  for (const code of WALLET_TYPE_CODES) {
    const [row] = await db
      .insert(schema.walletTypes)
      .values({ code })
      .onConflictDoNothing({ target: schema.walletTypes.code })
      .returning({ id: schema.walletTypes.id });
    const id = row?.id ?? (await db.select().from(schema.walletTypes).where(eq(schema.walletTypes.code, code)))[0].id;
    walletTypeIdByCode.set(code, id);
  }
  log.inserted('wallet_types', WALLET_TYPE_CODES.length);
}

async function getOrCreateLeader(name: string): Promise<number | null> {
  const trimmed = cleanText(name);
  if (!trimmed || trimmed === '-') return null;
  if (leaderIdByName.has(trimmed)) return leaderIdByName.get(trimmed)!;
  const [row] = await db
    .insert(schema.leaders)
    .values({ name: trimmed })
    .onConflictDoNothing({ target: schema.leaders.name })
    .returning({ id: schema.leaders.id });
  const id = row?.id ?? (await db.select().from(schema.leaders).where(eq(schema.leaders.name, trimmed)))[0].id;
  leaderIdByName.set(trimmed, id);
  return id;
}

async function getOrCreateBrand(product: Product, code: string): Promise<number | null> {
  const trimmed = cleanText(code).toUpperCase();
  if (!trimmed || trimmed === '-') return null;
  const key = `${product}:${trimmed}`;
  if (brandIdByProductCode.has(key)) return brandIdByProductCode.get(key)!;
  const [row] = await db
    .insert(schema.brands)
    .values({ product, code: trimmed })
    .onConflictDoNothing({ target: [schema.brands.product, schema.brands.code] })
    .returning({ id: schema.brands.id });
  const id =
    row?.id ??
    (await db.select().from(schema.brands).where(and(eq(schema.brands.product, product), eq(schema.brands.code, trimmed))))[0].id;
  brandIdByProductCode.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// 1. agents  <-  "Opening AG" (Cashout A-D, Send Money L-O)
// ---------------------------------------------------------------------------

export async function importAgents(product: Product) {
  const table = 'agents';
  const range = product === 'cashout' ? 'Opening AG!A2:D' : 'Opening AG!L2:O';
  const rows = await fetchRange(range);

  for (const row of rows) {
    const agentCode = cleanText(row[0]);
    if (isRosterInvalid(agentCode)) {
      if (row.some((c) => cleanText(c) !== '')) log.rejected(table, 'invalid agent name', row);
      continue;
    }
    const openingBalance = cleanNumber(row[1]);
    const leaderId = await getOrCreateLeader(cleanText(row[3]));

    const existing = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), eq(schema.agents.agentCode, agentCode)));

    await db
      .insert(schema.agents)
      .values({
        product,
        agentCode,
        leaderId,
        openingBalance: openingBalance === null ? null : String(openingBalance),
        sdp: cleanNumber(row[2]) === null ? null : String(cleanNumber(row[2])),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.agents.product, schema.agents.agentCode],
        set: {
          leaderId,
          openingBalance: openingBalance === null ? null : String(openingBalance),
          sdp: cleanNumber(row[2]) === null ? null : String(cleanNumber(row[2])),
          updatedAt: new Date(),
        },
      });

    if (existing.length > 0) log.updated(table);
    else log.inserted(table);
  }
}

// ---------------------------------------------------------------------------
// 2. agent_wallets  <-  "SSP AG BalanceLimit" / "SSP PS BalanceLimit"
// Current-state snapshot, no natural per-row key -> delete+replace per
// product, transactional.
// ---------------------------------------------------------------------------

export async function importAgentWallets(product: Product) {
  const table = 'agent_wallets';
  const rows =
    product === 'cashout' ? await fetchBalanceLimitRows() : await fetchRange('SSP PS BalanceLimit');

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode, a.id]));

  // ALL of each agent's Group values (not just the first) — resolveBrand
  // needs the full list since it picks the MOST FREQUENT code, not the
  // first-seen one.
  const groupsByAgentId = new Map<number, string[]>();

  type NewAgentWallet = typeof schema.agentWallets.$inferInsert;
  const toInsert: NewAgentWallet[] = [];

  for (const row of rows.slice(1)) {
    // Cashout's "SSP AG BalanceLimit" has a leading "Reference" column
    // (col 0) before Wallet Name (col 1). Send Money's "SSP PS
    // BalanceLimit" has no such leading column, so its Wallet Name is
    // col 0 (col 1 there is Account Status instead) — confirmed against
    // real sheet data. Using row[1] unconditionally for both products was
    // a bug: every Send Money row matched an Account Status string
    // ("DP + WD", "Not Connected", etc.) against agentIdByCode instead of
    // a real shop code, so 100% of Send Money wallet rows were rejected.
    const walletName = cleanText(product === 'cashout' ? row[1] : row[0]);
    if (isRosterInvalid(walletName)) continue;
    const agentId = agentIdByCode.get(walletName);
    if (!agentId) {
      log.rejected(table, `no matching agent for wallet name "${walletName}"`, row);
      continue;
    }
    const walletTypeCode = resolveWalletTypeCode(product, row[4]);
    const groupCode = cleanText(row[6]);
    if (!groupsByAgentId.has(agentId)) groupsByAgentId.set(agentId, []);
    groupsByAgentId.get(agentId)!.push(groupCode);

    // Same leading-column shift as walletName above: Cashout's "SSP AG
    // BalanceLimit" has Account Status at col 2 (after Reference/Wallet
    // Name); Send Money's "SSP PS BalanceLimit" has no leading Reference
    // column, so its Account Status is col 1 (col 2 there is Remaining
    // MonthlyLimit instead) — confirmed against real sheet headers. This
    // was missed when walletName was fixed; account_status is stored as
    // "300000" for 10,892/10,895 Send Money rows as a result.
    const accountStatus = cleanText(product === 'cashout' ? row[2] : row[1]);

    toInsert.push({
      agentId,
      walletTypeId: walletTypeIdByCode.get(walletTypeCode) ?? null,
      accountStatus: accountStatus || null,
      groupCode: groupCode || null,
      balance: cleanNumber(row[8]) === null ? null : String(cleanNumber(row[8])),
      totalDp: cleanNumber(row[11]) === null ? null : String(cleanNumber(row[11])),
      totalWd: cleanNumber(row[13]) === null ? null : String(cleanNumber(row[13])),
      isLoggedIn: cleanText(row[15]).toLowerCase() === 'yes',
      updatedAt: new Date(),
    });
  }

  // Insert in chunks — a single values() call for a large product (Send
  // Money's ~10,890 rows × 9 columns) exceeds PostgreSQL's ~65,535
  // bound-parameter limit per query and fails outright (confirmed: "bind
  // message has 32519 parameter formats but 0 parameters", PG error
  // 08P01). Cashout's smaller batch never hit this. 500 rows × 9 cols =
  // 4,500 params/statement, comfortably under the limit regardless of how
  // large either product's roster grows.
  const INSERT_CHUNK_SIZE = 500;
  await db.transaction(async (tx) => {
    const agentIds = agentRows.map((a) => a.id);
    if (agentIds.length > 0) {
      await tx.delete(schema.agentWallets).where(inArray(schema.agentWallets.agentId, agentIds));
    }
    for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(schema.agentWallets).values(toInsert.slice(i, i + INSERT_CHUNK_SIZE));
    }
  });
  log.inserted(table, toInsert.length);

  // agents.brand_id backfill using the REAL dashboard resolveBrand logic
  // (app/lib/balanceEngine.ts), not an approximation — matches
  // app/agentbal + app/sendmoney/balances exactly.
  const brandConfig = product === 'cashout' ? CASHOUT_BRAND_CONFIG : SENDMONEY_BRAND_CONFIG;
  for (const agentRow of agentRows) {
    // Call resolveBrand() unconditionally, even with zero groups (an agent
    // with no Balance Limit wallet rows) — resolveBrand's own fallback still
    // resolves a brand by matching known codes against the agent's own code
    // string, exactly what the live Sheets pages already do unconditionally.
    // Previously this loop skipped the call entirely when groups was empty,
    // leaving brand_id permanently null for every zero-wallet agent even
    // though the live page shows a real resolved brand for them — confirmed
    // via a side-by-side /sendmoney/balances localhost comparison.
    const groups = groupsByAgentId.get(agentRow.id) ?? [];
    const resolved = resolveBrand(groups, agentRow.agentCode, brandConfig);
    if (resolved === '−') continue; // unresolved — leave agents.brand_id null, matches dashboard's own "−" display
    const brandId = await getOrCreateBrand(product, resolved);
    if (brandId) await db.update(schema.agents).set({ brandId }).where(eq(schema.agents.id, agentRow.id));
  }
}

// ---------------------------------------------------------------------------
// 3. wallet_transactions  <-  "AG BD STLM + TOPUP" / "PS BD STLM + TOPUP"
// Historical/append-only. Idempotency via source_row_ref, checked in code
// (no DB-level unique constraint — kept out of scope for this data-only
// migration pass).
// ---------------------------------------------------------------------------

export async function importWalletTransactions(product: Product) {
  const table = 'wallet_transactions';
  const sheetName = product === 'cashout' ? 'AG BD STLM + TOPUP' : 'PS BD STLM + TOPUP';
  const rows = await fetchRange(sheetName);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode, a.id]));

  const existingRefs = new Set(
    (
      await db
        .select({ ref: schema.walletTransactions.sourceRowRef })
        .from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.product, product))
    ).map((r) => r.ref)
  );

  type NewTx = typeof schema.walletTransactions.$inferInsert;
  const toInsert: NewTx[] = [];

  function handleBlock(
    block: 'topup' | 'settlement',
    agentCol: number,
    amountCol: number,
    dateCol: number,
    walletCol: number,
    remarksCol: number | null
  ) {
    rows.slice(1).forEach((row, i) => {
      const sourceRowRef = `${product}:${block}:${i + 2}`; // +2 = 1-based sheet row, header on row 1
      if (existingRefs.has(sourceRowRef)) {
        log.skipped(table);
        return;
      }
      const rawAgent = cleanText(row[agentCol]);
      const rawAmount = cleanText(row[amountCol]);
      const rawDate = cleanText(row[dateCol]);
      if (!rawAgent || rawAgent === '-' || !rawAmount || rawAmount === '-') return; // blank row, not an error
      const agentCode = stripBrandSuffix(rawAgent);
      const agentId = agentIdByCode.get(agentCode);
      const occurredOn = parseSlashDate(rawDate);
      const amount = cleanNumber(rawAmount);
      if (!agentId) {
        log.rejected(table, `no matching agent for "${rawAgent}"`, row);
        return;
      }
      if (!occurredOn) {
        log.rejected(table, `unparseable date "${rawDate}"`, row);
        return;
      }
      if (amount === null) {
        log.rejected(table, `unparseable amount "${rawAmount}"`, row);
        return;
      }
      toInsert.push({
        product,
        agentId,
        transactionType: block,
        amount: String(Math.abs(amount)),
        wallet: cleanText(row[walletCol]) || null,
        occurredOn,
        remarks: remarksCol !== null ? cleanText(row[remarksCol]) || null : null,
        sourceRowRef,
      });
    });
  }

  handleBlock('topup', 1, 2, 3, 4, null); // B-F: agent,amount,date,wallet,type(unused)
  // Settlement col L (idx 11): confirmed real "Remarks" for Cashout; Send
  // Money's same slot holds Type instead (already captured via block name
  // above) — only pass remarksCol for Cashout.
  handleBlock('settlement', 7, 8, 9, 10, product === 'cashout' ? 11 : null);

  if (toInsert.length > 0) {
    await db.insert(schema.walletTransactions).values(toInsert);
  }
  log.inserted(table, toInsert.length);
}

// ---------------------------------------------------------------------------
// 4. wallet_status_overrides  <-  "Wallet Status"
// ---------------------------------------------------------------------------

export async function importWalletStatus(product: Product) {
  const table = 'wallet_status_overrides';

  // Once Postgres is the live write source for Wallet Status (Phase 3's
  // flag flip), Sheets becomes a frozen, no-longer-edited snapshot — a
  // scheduled re-import from it would silently overwrite real Postgres-
  // native edits with stale data every run. Skipping here is what makes it
  // safe to leave this function wired into runSlowSync()/runFullSync()
  // indefinitely rather than needing to remember to remove the call at
  // cutover time. Per-product flags (Cashout and Send Money cut over
  // independently — Cashout is held back pending the 1,479-shadow-agent
  // roster investigation).
  const flagName = product === 'cashout' ? 'NEXT_PUBLIC_WALLET_STATUS_SOURCE_CASHOUT' : 'NEXT_PUBLIC_WALLET_STATUS_SOURCE_SENDMONEY';
  if (process.env[flagName] === 'postgres') {
    console.log(`  [wallet_status_overrides] Postgres already live for ${product} — Sheets re-import skipped.`);
    log.skipped(table);
    return;
  }

  const [statusMap, remarksMap, overridesMap] = await Promise.all([
    product === 'cashout' ? readCashoutWalletStatus() : readSendMoneyWalletStatus(),
    product === 'cashout' ? readCashoutWalletRemarks() : readSendMoneyWalletRemarks(),
    product === 'cashout' ? readCashoutWalletOverrides() : readSendMoneyWalletOverrides(),
  ]);
  const merged = mergeWalletStatusRemarksAndOverrides(statusMap, remarksMap, overridesMap);

  // mergeWalletStatusRemarksAndOverrides returns a flat Record, not a Map —
  // all three sources' fields (status/remark/override) are spread onto one
  // flat object per shop key (e.g. `.remark`/`.updatedBy`/`.updatedAt` are
  // plain top-level fields, not nested under `.remark`/`.override`).
  // shopKey resolution (bare agentCode for Send Money, agentCode+wallet-
  // suffix for Cashout) reuses walletStatusConfigService.ts's own
  // resolveTarget/selectCurrentRow/upsertRow — see this file's own import
  // comment for why a second implementation of this mapping is exactly
  // what produced the original bug.
  for (const [shopKey, entry] of Object.entries(merged)) {
    let target;
    try {
      target = await resolveWalletStatusTarget(db, product, shopKey);
    } catch (err) {
      log.rejected(table, err instanceof Error ? err.message : String(err), { shopKey });
      continue;
    }

    const current = await selectCurrentWalletStatusRow(db, target);

    const values = {
      depositEnabled: entry.deposit === 'Yes',
      withdrawalEnabled: entry.withdrawal === 'Yes',
      priority: entry.priority,
      status: entry.walletStatus || null,
      remark: entry.remark || null,
      remarkUpdatedBy: entry.updatedBy || null,
      remarkUpdatedAt: entry.updatedAt ? new Date(entry.updatedAt) : null,
      mainReason: entry.mainReason || null,
      closureType: entry.closureType || null,
      affectedServices: entry.affectedServices,
      minimumAmountCanTake: entry.minimumAmountCanTake === null ? null : String(entry.minimumAmountCanTake),
      balanceLimitOverride: entry.balanceLimitOverride === null ? null : String(entry.balanceLimitOverride),
      scheduleOverride: entry.scheduleOverride || null,
    };

    await upsertWalletStatusOverridesRow(db, target, current, values);

    if (current) log.updated(table);
    else log.inserted(table);
  }
  // wallet_status_history: intentionally not populated here — no historical
  // source exists in the sheet (see migration plan).
}

// ---------------------------------------------------------------------------
// 5. Transfer Queue Settings
// ---------------------------------------------------------------------------

// Confirmed live vs draft against transferQueueSettings.ts's own RuleSection
// comment — see schema.ts's own note on transferQueueRules.
const LIVE_SECTIONS = new Set(['cashout_day', 'cashout_extended', 'cashout_247', 'sendmoney_247', 'sendmoney_bd']);

export async function importTransferQueueRules() {
  const table = 'transfer_queue_rules';
  const rules: RuleRow[] = await readTransferQueueRules();

  const bySection = new Map<string, RuleRow[]>();
  for (const rule of rules) {
    if (!bySection.has(rule.section)) bySection.set(rule.section, []);
    bySection.get(rule.section)!.push(rule);
  }

  for (const [section, sectionRules] of bySection) {
    for (let i = 0; i < sectionRules.length; i++) {
      const rule = sectionRules[i];
      const existing = await db
        .select({ id: schema.transferQueueRules.id })
        .from(schema.transferQueueRules)
        .where(and(eq(schema.transferQueueRules.section, section), eq(schema.transferQueueRules.rowOrder, i)));

      await db
        .insert(schema.transferQueueRules)
        .values({
          section,
          rowOrder: i,
          metric: rule.metric,
          operator: rule.operator,
          value1: String(rule.value1),
          value2: rule.value2 === null ? null : String(rule.value2),
          queueResult: rule.queueResult,
          enabled: rule.enabled,
          isLive: LIVE_SECTIONS.has(section),
          updatedBy: rule.updatedBy || null,
          updatedAt: rule.updatedAt ? new Date(rule.updatedAt) : new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.transferQueueRules.section, schema.transferQueueRules.rowOrder],
          set: {
            metric: rule.metric,
            operator: rule.operator,
            value1: String(rule.value1),
            value2: rule.value2 === null ? null : String(rule.value2),
            queueResult: rule.queueResult,
            enabled: rule.enabled,
            isLive: LIVE_SECTIONS.has(section),
            updatedBy: rule.updatedBy || null,
            updatedAt: rule.updatedAt ? new Date(rule.updatedAt) : new Date(),
          },
        });
      if (existing.length > 0) log.updated(table);
      else log.inserted(table);
    }
  }
}

export async function importTransferQueueBundleSettings() {
  const table = 'transfer_queue_bundle_settings';
  const fields = await readBundleConfig();
  for (const field of fields) {
    const existing = await db
      .select({ id: schema.transferQueueBundleSettings.id })
      .from(schema.transferQueueBundleSettings)
      .where(eq(schema.transferQueueBundleSettings.fieldName, field.field));

    await db
      .insert(schema.transferQueueBundleSettings)
      .values({ fieldName: field.field, fieldValue: field.value })
      .onConflictDoUpdate({
        target: schema.transferQueueBundleSettings.fieldName,
        set: { fieldValue: field.value },
      });
    if (existing.length > 0) log.updated(table);
    else log.inserted(table);
  }
}

// transfer_queue_meta_config is a singleton (one row) — reuses
// readMetaConfig()'s own parsing/fallback logic exactly rather than
// re-reading "Transfer Queue Configurations!P2:S3" directly.
export async function importTransferQueueMetaConfig() {
  const table = 'transfer_queue_meta_config';
  const meta = await readMetaConfig();

  const existing = await db.select({ id: schema.transferQueueMetaConfig.id }).from(schema.transferQueueMetaConfig).limit(1);
  const values = {
    mode: meta.mode,
    version: meta.version,
    updatedBy: meta.updatedBy || null,
    updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : null,
  };

  if (existing.length > 0) {
    await db.update(schema.transferQueueMetaConfig).set(values).where(eq(schema.transferQueueMetaConfig.id, existing[0].id));
    log.updated(table);
  } else {
    await db.insert(schema.transferQueueMetaConfig).values(values);
    log.inserted(table);
  }
}

export async function importTransferQueueLinkedAccounts() {
  const table = 'transfer_queue_linked_accounts';
  const linked = await readLinkedCashoutAccounts(); // Map<sendmoneyWalletName, cashoutAgentName>

  const cashoutAgents = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, 'cashout'));
  const cashoutIdByCode = new Map(cashoutAgents.map((a) => [a.agentCode, a.id]));

  for (const [sendmoneyWalletName, cashoutAccountName] of linked) {
    const cashoutAgentId = cashoutIdByCode.get(cleanText(cashoutAccountName)) ?? null;
    if (!cashoutAgentId) {
      log.rejected(table, `linked Cashout account "${cashoutAccountName}" not found`, { sendmoneyWalletName, cashoutAccountName });
    }
    const existing = await db
      .select({ id: schema.transferQueueLinkedAccounts.id })
      .from(schema.transferQueueLinkedAccounts)
      .where(eq(schema.transferQueueLinkedAccounts.sendmoneyWalletName, sendmoneyWalletName));

    await db
      .insert(schema.transferQueueLinkedAccounts)
      .values({ sendmoneyWalletName, cashoutAgentId })
      .onConflictDoUpdate({
        target: schema.transferQueueLinkedAccounts.sendmoneyWalletName,
        set: { cashoutAgentId },
      });
    if (existing.length > 0) log.updated(table);
    else log.inserted(table);
  }
}

export async function importTransferQueueRuleHistory() {
  const table = 'transfer_queue_rule_history';
  const rows = await fetchRange('Transfer Queue Rule History!A2:L');

  const rules = await db.select().from(schema.transferQueueRules);
  const ruleIdBySectionMetric = new Map<string, number>();
  for (const r of rules) ruleIdBySectionMetric.set(`${r.section}:${r.metric}`, r.id);

  const existing = await db.select().from(schema.transferQueueRuleHistory);
  const existingKeys = new Set(existing.map((e) => `${e.ruleId}:${e.changedAt?.toISOString()}:${e.changedField}`));

  type NewHistory = typeof schema.transferQueueRuleHistory.$inferInsert;
  const toInsert: NewHistory[] = [];

  for (const row of rows) {
    const timestamp = cleanText(row[0]);
    const section = cleanText(row[1]);
    const metric = cleanText(row[2]);
    if (!timestamp || !section) continue;
    const changedAt = parseUploadTimestamp(timestamp) ?? new Date(timestamp);
    const ruleId = ruleIdBySectionMetric.get(`${section}:${metric}`) ?? null;
    const updatedBy = cleanText(row[11]);

    // Decompose the row's old/new field pairs (operator, value1, value2,
    // queueResult) into one history entry per field that actually changed —
    // fits the existing table's generic (changed_field, old_value,
    // new_value) shape without needing a schema change for this richer
    // source structure.
    const fieldPairs: [string, string, string][] = [
      ['operator', cleanText(row[3]), cleanText(row[7])],
      ['value1', cleanText(row[4]), cleanText(row[8])],
      ['value2', cleanText(row[5]), cleanText(row[9])],
      ['queueResult', cleanText(row[6]), cleanText(row[10])],
    ];
    for (const [field, oldVal, newVal] of fieldPairs) {
      if (oldVal === newVal) continue;
      const key = `${ruleId}:${changedAt.toISOString()}:${field}`;
      if (existingKeys.has(key)) {
        log.skipped(table);
        continue;
      }
      toInsert.push({ ruleId, changedField: field, oldValue: oldVal || null, newValue: newVal || null, changedBy: updatedBy || null, changedAt });
    }
  }

  if (toInsert.length > 0) await db.insert(schema.transferQueueRuleHistory).values(toInsert);
  log.inserted(table, toInsert.length);
}

// ---------------------------------------------------------------------------
// 6. dashboard_manual_balances  <-  "Dashboard Overview"
// ---------------------------------------------------------------------------

export async function importDashboardManualBalances(product: Product) {
  const table = 'dashboard_manual_balances';
  const range = product === 'cashout' ? 'Dashboard Overview!B3:I8' : 'Dashboard Overview!B11:I16';
  const rows = await fetchRange(range);

  for (const row of rows.slice(1)) {
    const wallet = cleanText(row[0]).toUpperCase();
    if (!wallet) continue;
    const values = {
      totalDp: cleanNumber(row[1]) === null ? null : String(cleanNumber(row[1])),
      totalWd: cleanNumber(row[2]) === null ? null : String(cleanNumber(row[2])),
      // row[3]/row[4] (BD-Transfer IN / STLM Out) intentionally skipped —
      // confirmed always zero in-sheet, see migration plan.
      actualBalance: cleanNumber(row[5]) === null ? null : String(cleanNumber(row[5])),
      runningBalance: cleanNumber(row[6]) === null ? null : String(cleanNumber(row[6])),
      openingBalance: cleanNumber(row[7]) === null ? null : String(cleanNumber(row[7])),
      recordedAt: new Date(),
    };
    const existing = await db
      .select({ id: schema.dashboardManualBalances.id })
      .from(schema.dashboardManualBalances)
      .where(and(eq(schema.dashboardManualBalances.product, product), eq(schema.dashboardManualBalances.wallet, wallet)));

    await db
      .insert(schema.dashboardManualBalances)
      .values({ product, wallet, ...values })
      .onConflictDoUpdate({
        target: [schema.dashboardManualBalances.product, schema.dashboardManualBalances.wallet],
        set: values,
      });
    if (existing.length > 0) log.updated(table);
    else log.inserted(table);
  }
}

// ---------------------------------------------------------------------------
// 7. brand_ssp_line1 + brand_cash_inhand  <-  "Brand Balance"
// No natural unique key -> delete+replace, transactional.
// ---------------------------------------------------------------------------

// Send Money's own SSP Line1 block ("Brand Balance!B16:G26") — confirmed
// via live fetch to be the exact same 6-column shape as Cashout's B3:G13
// (Brand/Opening Balance/DEPOSIT/WITHDRAWAL/ADJUSTMENT/TOTAL), reused by
// app/page.tsx's own parseSspLine1() for both products already. Both
// ranges include their own header row at index 0 — FIXED: the original
// version of this function had no `.slice(1)`, so that header row's text
// ("Brand","Opening Balance",...) got inserted as a fake brand with
// code="BRAND" and every numeric field null (confirmed live in the
// already-migrated Cashout data before this fix).
export async function importBrandSspLine1(product: Product) {
  const table = 'brand_ssp_line1';
  const range = product === 'cashout' ? 'Brand Balance!B3:G13' : 'Brand Balance!B16:G26';
  const rows = await fetchRange(range);

  type NewRow = typeof schema.brandSspLine1.$inferInsert;
  const toInsert: NewRow[] = [];
  for (const row of rows.slice(1)) {
    const code = cleanText(row[0]);
    if (!code || code === '-') continue;
    const brandId = await getOrCreateBrand(product, code);
    if (!brandId) continue;
    toInsert.push({
      product,
      brandId,
      openingBalance: cleanNumber(row[1]) === null ? null : String(cleanNumber(row[1])),
      deposit: cleanNumber(row[2]) === null ? null : String(cleanNumber(row[2])),
      withdrawal: cleanNumber(row[3]) === null ? null : String(cleanNumber(row[3])),
      adjustment: cleanNumber(row[4]) === null ? null : String(cleanNumber(row[4])),
      total: cleanNumber(row[5]) === null ? null : String(cleanNumber(row[5])),
      recordedAt: new Date(),
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.brandSspLine1).where(eq(schema.brandSspLine1.product, product));
    if (toInsert.length > 0) await tx.insert(schema.brandSspLine1).values(toInsert);
  });
  log.inserted(table, toInsert.length);
}

export async function importBrandCashInhand() {
  const table = 'brand_cash_inhand';
  const rows = await fetchRange('Brand Balance!B29:H40');

  type NewRow = typeof schema.brandCashInhand.$inferInsert;
  const toInsert: NewRow[] = [];
  for (const row of rows.slice(1)) {
    const code = cleanText(row[0]);
    if (!code || code === '-' || code.toLowerCase().includes('total')) continue;
    // Brand here isn't tied to a single product (Cash-in-Hand spans both) —
    // registered under 'cashout' as the canonical brand-code namespace
    // since M1/M2/K1/B1-B5/T1/J1/SH are shared codes, not product-specific.
    const brandId = await getOrCreateBrand('cashout', code);
    if (!brandId) continue;
    toInsert.push({
      brandId,
      sspAg: cleanNumber(row[1]) === null ? null : String(cleanNumber(row[1])),
      sspPs: cleanNumber(row[2]) === null ? null : String(cleanNumber(row[2])),
      ess: cleanNumber(row[3]) === null ? null : String(cleanNumber(row[3])),
      autopay: cleanNumber(row[4]) === null ? null : String(cleanNumber(row[4])),
      expay: cleanNumber(row[5]) === null ? null : String(cleanNumber(row[5])),
      totalCih: cleanNumber(row[6]) === null ? null : String(cleanNumber(row[6])),
      recordedAt: new Date(),
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.brandCashInhand);
    if (toInsert.length > 0) await tx.insert(schema.brandCashInhand).values(toInsert);
  });
  log.inserted(table, toInsert.length);
}

// ---------------------------------------------------------------------------
// 8. cashgo_daily  <-  "CashGo"
// ---------------------------------------------------------------------------

export async function importCashgoDaily() {
  const table = 'cashgo_daily';
  const product: Product = 'cashout'; // confirmed no Send Money equivalent sheet
  const rows = await fetchRange('CashGo!A2:F');

  for (const row of rows) {
    const trendDate = parseCashGoDate(cleanText(row[1]));
    if (!trendDate) {
      if (row.some((c) => cleanText(c) !== '')) log.rejected(table, `unparseable date "${cleanText(row[1])}"`, row);
      continue;
    }
    const metrics: [string, number | null, number | null][] = [
      ['BKASH', cleanNumber(row[2]), cleanNumber(row[4])],
      ['NAGAD', cleanNumber(row[3]), cleanNumber(row[5])],
    ];
    for (const [walletType, quota, processed] of metrics) {
      const values = {
        quota: quota === null ? null : String(quota),
        processed: processed === null ? null : String(processed),
      };
      const existing = await db
        .select({ id: schema.cashgoDaily.id })
        .from(schema.cashgoDaily)
        .where(
          and(
            eq(schema.cashgoDaily.product, product),
            eq(schema.cashgoDaily.trendDate, trendDate),
            eq(schema.cashgoDaily.walletType, walletType)
          )
        );
      await db
        .insert(schema.cashgoDaily)
        .values({ product, trendDate, walletType, ...values })
        .onConflictDoUpdate({
          target: [schema.cashgoDaily.product, schema.cashgoDaily.trendDate, schema.cashgoDaily.walletType],
          set: values,
        });
      if (existing.length > 0) log.updated(table);
      else log.inserted(table);
    }
  }
}

// ---------------------------------------------------------------------------
// 9. estimated_balance_uploads + _entries + _wallet_totals  <-  "Estimated Opening"
// importEstimatedOpening() now lives in the shared sync module (imported
// above) — same code the live Opening upload API routes call after a
// successful Google Sheets write.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. roster_sync_log  <-  "Opening AG" col G/I cutoff card
// fetchRosterCutoffDate() now lives in the shared sync module (imported
// above) — also used by importEstimatedOpening() there (same underlying
// card) to resolve the real reportCutoffDate instead of approximating it.
// ---------------------------------------------------------------------------

export async function importRosterSyncLog(product: Product) {
  const table = 'roster_sync_log';
  const syncedAt = await fetchRosterCutoffDate(product);
  if (!syncedAt) {
    log.rejected(table, 'no parseable cutoff card found', { product });
    return;
  }

  const existing = await db
    .select({ id: schema.rosterSyncLog.id })
    .from(schema.rosterSyncLog)
    .where(and(eq(schema.rosterSyncLog.product, product), eq(schema.rosterSyncLog.syncedAt, syncedAt)));
  if (existing.length > 0) {
    log.skipped(table);
    return;
  }
  await db.insert(schema.rosterSyncLog).values({ product, syncedAt });
  log.inserted(table);
}

// ---------------------------------------------------------------------------
// Orchestration — dependency order: reference data -> agents -> everything
// that references agents -> independent snapshot tables.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scheduled sync groups (app/api/admin/sync-postgres) — each domain synced
// at the cadence its own real update frequency + measured runtime justify,
// not one blanket interval. FAST (Transfer Queue config, Brand Balance,
// Dashboard Manual Balances, CashGo, Roster Sync Log) measured ~103s
// combined; SLOW (Agents, Agent Wallets, Wallet Transactions, Wallet
// Status) is realistically 20-40+ minutes given the existing import
// functions' per-row sequential DB round-trips (unchanged here, per
// instruction — not optimized in this pass). Estimated Opening
// deliberately has NO scheduled group — it already syncs on every real
// upload via app/lib/db/sync/estimatedOpeningSync.ts, unrelated to this.
// transfer_queue_rule_history also isn't in either group — no live
// dashboard consumer reads it today, and it wasn't in the approved list
// for either group; still reachable via runFullSync() for a manual/CLI run.
// ---------------------------------------------------------------------------

export type SyncGroup = 'fast' | 'slow';
export class SyncAlreadyRunningError extends Error {
  constructor(group: SyncGroup) {
    super(`A ${group} sync is already running`);
  }
}

// Generous multiples of each group's measured/estimated worst-case runtime
// — a 'running' row older than this is treated as abandoned (the process
// that started it was killed before reaching the finally-block below,
// exactly what happened once already this session) rather than blocking
// every future run of that group forever.
const STALE_RUN_THRESHOLD_MS: Record<SyncGroup, number> = {
  fast: 20 * 60 * 1000, // 20 min (measured ~103s)
  slow: 3 * 60 * 60 * 1000, // 3 hours (estimated 20-40 min, schedule is every 2h)
};

// Postgres unique-violation code — surfaces either directly on the thrown
// error or wrapped inside Drizzle's own error's `.cause`, depending on
// driver path; check both.
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

// Claims a 'running' row for `group` atomically via the partial unique
// index on sync_runs (sync_group) WHERE status='running' — the INSERT
// itself is the lock: only one concurrent caller can ever succeed. A
// plain "SELECT for an existing running row, then INSERT if none found"
// (the first version of this function) has a race window between the two
// statements that two concurrent requests can both slip through — confirmed
// live: two concurrent FAST requests both returned 200 and both wrote data.
async function claimRun(group: SyncGroup): Promise<number> {
  try {
    const [run] = await db.insert(schema.syncRuns).values({ syncGroup: group, status: 'running' }).returning({ id: schema.syncRuns.id });
    return run.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Another 'running' row exists — check whether it's stale (the
    // process that started it was killed before reaching the finally
    // below, exactly what happened once already this session) rather than
    // genuinely in progress.
    const [existing] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.syncGroup, group), eq(schema.syncRuns.status, 'running')))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1);

    const ageMs = existing ? Date.now() - existing.startedAt.getTime() : Infinity;
    if (!existing || ageMs < STALE_RUN_THRESHOLD_MS[group]) {
      throw new SyncAlreadyRunningError(group);
    }

    // Stale — reclaim it, then retry the claim. If a third concurrent
    // caller wins this retry, claimRun() throws SyncAlreadyRunningError
    // above on ITS OWN retry, correctly — reclaiming a crashed run is a
    // rare, post-crash event, not a normal-operation hot path, so a single
    // retry (not a loop) is enough here.
    await db
      .update(schema.syncRuns)
      .set({ status: 'failure', finishedAt: new Date(), errorMessage: 'Abandoned: process terminated before completion (stale run reclaimed)' })
      .where(eq(schema.syncRuns.id, existing.id));
    const [run] = await db.insert(schema.syncRuns).values({ syncGroup: group, status: 'running' }).returning({ id: schema.syncRuns.id });
    return run.id;
  }
}

async function runGroupSync(group: SyncGroup, work: () => Promise<void>): Promise<void> {
  const runId = await claimRun(group);

  // Fresh logger per run, isolated via AsyncLocalStorage (see `log`'s own
  // definition above) — the shared module-level counter this was
  // originally built on was written for a single one-shot CLI process
  // that always exited right after; two runGroupSync() calls active at
  // once (same group racing before this fix, or FAST and SLOW legitimately
  // running concurrently) would otherwise both increment the SAME counters
  // and each read back a mix of both runs' counts. Confirmed live: two
  // concurrent FAST runs each reported double the real per-run totals.
  const runLogger = new MigrationLogger();
  await loggerContext.run(runLogger, async () => {
    try {
      await work();
      const totals = runLogger.getTotals();
      await db
        .update(schema.syncRuns)
        .set({
          status: 'success',
          finishedAt: new Date(),
          insertedTotal: totals.inserted,
          updatedTotal: totals.updated,
          skippedTotal: totals.skipped,
          rejectedTotal: totals.rejected,
        })
        .where(eq(schema.syncRuns.id, runId));
      runLogger.report();
    } catch (err) {
      const totals = runLogger.getTotals();
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.syncRuns)
        .set({
          status: 'failure',
          finishedAt: new Date(),
          insertedTotal: totals.inserted,
          updatedTotal: totals.updated,
          skippedTotal: totals.skipped,
          rejectedTotal: totals.rejected,
          errorMessage: message,
        })
        .where(eq(schema.syncRuns.id, runId));
      throw err;
    }
  });
}

export async function runFastSync(): Promise<void> {
  await runGroupSync('fast', async () => {
    await importTransferQueueRules();
    await importTransferQueueBundleSettings();
    await importTransferQueueMetaConfig();
    await importTransferQueueLinkedAccounts();
    await importBrandSspLine1('cashout');
    await importBrandSspLine1('sendmoney');
    await importBrandCashInhand();
    await importDashboardManualBalances('cashout');
    await importDashboardManualBalances('sendmoney');
    await importCashgoDaily();
    await importRosterSyncLog('cashout');
    await importRosterSyncLog('sendmoney');
  });
}

export async function runSlowSync(): Promise<void> {
  await runGroupSync('slow', async () => {
    await seedWalletTypes();
    for (const product of ['cashout', 'sendmoney'] as Product[]) {
      await importAgents(product);
      await importAgentWallets(product);
      // Phase 10 — disabled. Settlement/Top Up now enter PostgreSQL only
      // through the Brand-required upload flow (importSettlementFile/
      // importTopUpFile in importService.ts), never through this Sheets
      // sync. importWalletTransactions() itself is left defined, just
      // unused here — every row it already wrote stays exactly as-is
      // (brand_id NULL, historical, untouched, per explicit instruction).
      // The live "AG BD STLM + TOPUP" / "PS BD STLM + TOPUP" sheets are
      // never written to by this function either way, so nothing about the
      // old Sheets data changes by disabling this call.
      // await importWalletTransactions(product);
      await importWalletStatus(product);
    }
  });
}

// The actual orchestration, split out from main() so a caller that must
// NOT exit the process (the scheduled-sync API route, run inside the
// live PM2-managed server) can reuse the exact same sequence — main()'s
// own process.exit(0) below would kill the entire server, not just one
// request, if called from within it. Kept as its own complete
// orchestration (not simply runFastSync()+runSlowSync()) so the CLI/manual
// full-migration path still covers transfer_queue_rule_history and
// Estimated Opening, neither of which is in the scheduled fast/slow groups.
export async function runFullSync(): Promise<void> {
  console.log('=== Google Sheets -> PostgreSQL data migration ===');
  console.log('(read-only against Sheets; idempotent writes against Postgres)\n');

  await seedWalletTypes();

  for (const product of ['cashout', 'sendmoney'] as Product[]) {
    console.log(`\n--- ${product} ---`);
    await importAgents(product);
    await importAgentWallets(product);
    await importWalletTransactions(product);
    await importWalletStatus(product);
    await importDashboardManualBalances(product);
    await importEstimatedOpening(product, log);
    await importRosterSyncLog(product);
  }

  console.log('\n--- shared / config ---');
  await importTransferQueueRules();
  await importTransferQueueBundleSettings();
  await importTransferQueueMetaConfig();
  await importTransferQueueLinkedAccounts();
  await importTransferQueueRuleHistory();
  await importBrandSspLine1('cashout');
  await importBrandSspLine1('sendmoney');
  await importBrandCashInhand();
  await importCashgoDaily();

  log.report();
  console.log('\nDone. Google Sheets were not modified. Dashboard still reads from Sheets, not Postgres.');
}

async function main() {
  await runFullSync();
  process.exit(0);
}

// Only run the full migration when this file is executed directly
// (`npx tsx scripts/migrate-data.ts`) — NOT when another script imports its
// functions (e.g. seedWalletTypes/importAgentWallets) for a scoped, single-
// table repair. Without this guard, importing this module as a library
// also fires this full run as a side effect (confirmed the hard way: a
// scoped Send Money repair unintentionally triggered a second, concurrent
// full migration).
if (require.main === module) {
  main().catch((err) => {
    console.error('\nMIGRATION FAILED:', err);
    log.report();
    process.exit(1);
  });
}
