// Server-side XLSX import pipeline — LOCAL/FOUNDATION ONLY, not wired into
// any existing page or route. Reuses every existing parsing/validation
// module UNCHANGED (xlsxParser.ts, settlementValidation.ts,
// topupValidation.ts, openingValidation.ts, duplicateDetector.ts,
// importSummary.ts) — none of that logic is reimplemented here, only
// orchestrated, per explicit instruction not to duplicate business rules.
//
// Client-side validation (BulkImportModal.tsx) still exists for UX and is
// UNCHANGED — but per explicit instruction, this server-side pass is the
// one that's actually trusted before anything reaches PostgreSQL. A row
// the client marked "valid" is re-validated here from scratch; nothing
// from the client request is trusted blindly.
//
// Replaces the concept of duplicateDetector.ts's mockExistingRecordCheck()
// (explicitly documented in that file as a "prototype-phase stand-in ...
// do NOT implement backend yet") with a real, deterministic fingerprint
// check against wallet_transactions. Per explicit instruction: a matching
// fingerprint FLAGS a row for review — it never silently merges or drops
// it. Both rows are always inserted and preserved.
import { createHash } from 'node:crypto';
import { eq, and, or, gt, inArray, notInArray, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { parseWorkbookFile, mapSettlementRows, mapTopUpRows, mapOpeningRows, type SettlementImportRow, type TopUpImportRow, type OpeningImportRow } from '../xlsxParser';
import { validateSettlementRows, parseImportDate, type ValidationEntry, type ValidationConfig } from '../settlementValidation';
import { validateTopUpRows, type TopUpValidationConfig } from '../topupValidation';
import { validateOpeningRows, normalizeShopNameForMatch } from '../openingValidation';
import { resolveOrCreateLeaderId } from './openingActionsService';
import { detectDuplicatesWithinFile, detectDuplicateAgentNames } from '../duplicateDetector';
import { classifyRow, calculateImportSummary, calculateOpeningImportSummary } from '../importSummary';
import { parseAmount } from '../format';
import { TOPUP_TYPE_OPTIONS } from '../topupOptions';
import { getBrandsForProduct } from '../db/read/brands';
import { getBusinessToday, manilaFields } from '../businessDate';
import { extractRawWalletFamily, extractShopSeriesFamily, extractOpeningWalletTypeSuffix } from '../realShopName';
import { buildGhostAgentMap, reconcileGhostsForImport } from './shopIdentityReconciliation';

export type Product = 'cashout' | 'sendmoney';
const WALLET_OPTIONS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];

// "Placeholder" Leader names — a row whose own Leader cell is one of these
// (or blank) hasn't really been assigned a real Leader yet, so a same-family
// sibling's real Leader (see buildFamilyLeaderMap below) should be preferred
// over reusing/creating a leader literally named this. Confirmed live: 1,275
// Send Money shops currently carry "New-TempAutoPlot" as their Leader, 631
// of which have a same-family sibling wallet line (e.g. "...-ARCANE040-BK"
// vs "...-ARCANE040-NG") whose OWN Leader cell already has the real answer
// ("JEWEL") — this never got applied because their shared brand ("ARCANE")
// isn't in KNOWN_BRAND_NAMES, so each wallet line becomes its own totally
// separate `agents` row with no identity link between them at all (see
// extractRawWalletFamily's own comment). 'NEW SHOP' included too — the same
// placeholder balanceLimitService.ts's own auto-create path uses; harmless
// for Opening rows since its own Leader column would only ever say this if
// someone typed it, but kept for consistency.
const PLACEHOLDER_LEADER_NAMES = new Set(['NEW SHOP', 'NEW-TEMPAUTOPLOT']);

export function isPlaceholderLeaderName(name: string): boolean {
  const trimmed = name.trim().toUpperCase();
  return trimmed === '' || trimmed === '-' || PLACEHOLDER_LEADER_NAMES.has(trimmed);
}

// Family -> real Leader name, brand-agnostic (extractRawWalletFamily, not
// extractShopFamily — this must also work for an unrecognized-brand shop
// whose agentCode is still a full raw string). Built once per import
// (product-scoped, read-only), same shape/reasoning as
// balanceLimitService.ts's own leaderNameByFamily: first-wins on a genuine
// same-family disagreement between two already-real Leaders (not something
// this map can safely arbitrate), placeholder-leader agents excluded from
// ever seeding an answer.
export async function buildFamilyLeaderMap(db: Tx | ReturnType<typeof getDb>, product: Product): Promise<Map<string, string>> {
  const rows = await db
    .select({ agentCode: schema.agents.agentCode, leaderName: schema.leaders.name })
    .from(schema.agents)
    .innerJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const map = new Map<string, string>();
  for (const r of rows) {
    if (isPlaceholderLeaderName(r.leaderName)) continue;
    const fam = extractRawWalletFamily(r.agentCode);
    if (!map.has(fam)) map.set(fam, r.leaderName);
  }
  return map;
}

// Broader fallback map, one level looser than buildFamilyLeaderMap: keyed by
// extractShopSeriesFamily (whole sequential-numbered shop series, e.g. every
// "YUSSOP0xx" shop, not just one shop's own two wallet lines) instead of
// extractRawWalletFamily. Confirmed safe against the live roster — zero
// series ever contain two different real Leaders — but still strictly a
// fallback: consult buildFamilyLeaderMap's tighter map first, only fall
// through to this one when that finds nothing (see its call sites).
export async function buildSeriesFamilyLeaderMap(db: Tx | ReturnType<typeof getDb>, product: Product): Promise<Map<string, string>> {
  const rows = await db
    .select({ agentCode: schema.agents.agentCode, leaderName: schema.leaders.name })
    .from(schema.agents)
    .innerJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  const map = new Map<string, string>();
  for (const r of rows) {
    if (isPlaceholderLeaderName(r.leaderName)) continue;
    const series = extractShopSeriesFamily(r.agentCode);
    if (!series || map.has(series)) continue;
    map.set(series, r.leaderName);
  }
  return map;
}

// Phase 10 — real brands table, replacing the old hardcoded
// CASHOUT_BRAND_CODES+'SH' array. Returns both the plain code list (for
// validateSettlementRows/validateTopUpRows' own brandOptions check) and a
// code->id map (for resolving each valid row's brandId before insert).
async function loadBrandMap(product: Product): Promise<Map<string, number>> {
  const brands = await getBrandsForProduct(product);
  const map = new Map<string, number>();
  for (const b of brands) map.set(b.code.toUpperCase(), b.id);
  return map;
}

// manilaFields, not date.getFullYear()/getMonth()/getDate() — those read
// the SERVER's own runtime timezone (UTC on the VPS). parsedDate here comes
// from settlementValidation.ts's parseImportDate, which (after its own
// Manila-midnight fix) returns an instant like "2026-09-23T16:00:00Z" for
// the calendar date "Sept 24" in Manila terms — UTC-local getters on that
// same instant read back "Sept 23", one day short. Confirmed live: a
// same-day Settlement upload validated correctly (validCount: 153) but
// every row got silently stored one calendar day early.
function formatDateOnly(date: Date): string {
  const { year, month, day } = manilaFields(date);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Deterministic dedup key. Does NOT include remarks/type — those are
// descriptive, not part of "is this the same transaction" identity.
// Phase 10 — brandId is now part of the identity: shops are shared across
// brands, so agentId alone no longer disambiguates by brand (that
// assumption is what this replaces). Same Agent+Wallet+Amount+Date under
// two different Brands are two distinct, valid transactions — this
// fingerprint change is what makes that true instead of one flagging the
// other as a duplicate.
function computeFingerprint(product: Product, transactionType: 'settlement' | 'topup', agentId: number, brandId: number, wallet: string, amount: number, occurredOn: string): string {
  const raw = [product, transactionType, agentId, brandId, wallet.trim().toLowerCase(), amount.toFixed(2), occurredOn].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export type ImportOutcome = {
  batchId: number;
  status: 'completed' | 'failed';
  rowCount: number;
  validCount: number;
  duplicateCount: number;
  errorCount: number;
  insertedIds: number[];
  flaggedDuplicateIds: number[];
  errors: ValidationEntry[];
};

async function loadAgentMap(product: Product): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode }).from(schema.agents).where(eq(schema.agents.product, product));
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.agentCode.toLowerCase(), r.id);
  return map;
}

// Phase 10 — Brand is the one field where a bad value rejects the WHOLE
// file, not just that row (explicit instruction: "Do not partially import
// valid rows from a file that contains Brand errors"). Every other field
// (Agent/Wallet/Amount/Date) keeps the existing per-row behavior — this is
// checked separately, before any row reaches insertTransactionRows, so a
// single bad Brand value blocks the entire batch with zero rows inserted.
function assertNoBrandErrors(issues: ValidationEntry[]): void {
  const brandErrors = issues.filter((e) => e.field === 'Brand' && e.type === 'error');
  if (brandErrors.length > 0) {
    const rows = brandErrors.map((e) => e.row).join(', ');
    throw new Error(`Upload rejected: missing or invalid Brand on row(s) ${rows}. Fix the file and re-upload — no rows were imported.`);
  }
}

export async function importSettlementFile(params: { product: Product; file: File; fileName: string; uploadedBy: string; excludedRows?: Set<number> }): Promise<ImportOutcome> {
  const db = getDb();
  const parsed = await parseWorkbookFile(params.file);
  const rows = mapSettlementRows(parsed, params.product);
  const agentIdByCode = await loadAgentMap(params.product);
  const brandIdByCode = await loadBrandMap(params.product);

  const config: ValidationConfig = {
    brandOptions: Array.from(brandIdByCode.keys()),
    walletOptions: WALLET_OPTIONS,
    agentRoster: Array.from(agentIdByCode.keys()),
    remarksSuggestions: [],
  };
  // Validated against the FULL, unfiltered row set — excludedRows (rows the
  // user Skipped client-side) is applied later, only to what actually gets
  // inserted. A skipped row can never be used to dodge assertNoBrandErrors'
  // whole-file rejection below; that check has to see every row exactly as
  // uploaded.
  const validationIssues = validateSettlementRows(rows, config);
  const withinFileDupes = detectDuplicatesWithinFile(rows);
  const allIssues = [...validationIssues, ...withinFileDupes];

  const [batch] = await db.insert(schema.importBatches).values({
    product: params.product, importType: 'settlement', fileName: params.fileName, uploadedBy: params.uploadedBy,
    rowCount: rows.length, status: 'processing', startedAt: new Date(),
  }).returning({ id: schema.importBatches.id });

  try {
    assertNoBrandErrors(allIssues);

    const result = await insertTransactionRows(params.product, 'settlement', batch.id, rows, allIssues, (row) => ({
      agentName: row.agentName, brand: row.brand, wallet: row.wallet, amount: row.amount, date: row.date, remarks: row.remarks,
    }), params.excludedRows);

    await db.update(schema.importBatches).set({
      status: 'completed', completedAt: new Date(),
      validCount: result.validCount, duplicateCount: result.duplicateCount, errorCount: result.errorCount,
      errorSummary: JSON.stringify(allIssues.filter((e) => e.type === 'error')),
    }).where(eq(schema.importBatches.id, batch.id));

    return { batchId: batch.id, status: 'completed', rowCount: rows.length, ...result, errors: allIssues };
  } catch (err) {
    await db.update(schema.importBatches).set({ status: 'failed', completedAt: new Date(), errorSummary: err instanceof Error ? err.message : String(err) }).where(eq(schema.importBatches.id, batch.id));
    throw err;
  }
}

export async function importTopUpFile(params: { product: Product; file: File; fileName: string; uploadedBy: string; excludedRows?: Set<number> }): Promise<ImportOutcome> {
  const db = getDb();
  const parsed = await parseWorkbookFile(params.file);
  const rows = mapTopUpRows(parsed, params.product);
  const agentIdByCode = await loadAgentMap(params.product);
  const brandIdByCode = await loadBrandMap(params.product);

  // Phase 7 fix — this used to be a hardcoded, WRONG local array
  // ('BUNDLE TRANSFER'/'INTERNAL TRANSFER', values that only ever appear as
  // this app's own DISPLAY-derived label, never as real upload-template
  // input) instead of the real, shared TOPUP_TYPE_OPTIONS the official
  // template and both products' own client-side validation already use
  // ('Bundle Transfer In'/'Internal Transfer In'/'Top Up' — see
  // topupOptions.ts). Confirmed live: every real Top Up upload's Type value
  // was rejected server-side under the old array while the client-side
  // preview showed 0 errors — the wizard's "Import Completed" screen (whose
  // numbers are computed client-side, not read from this route's response)
  // never surfaced that the server had actually inserted nothing.
  const config: TopUpValidationConfig = {
    brandOptions: Array.from(brandIdByCode.keys()),
    walletOptions: WALLET_OPTIONS,
    agentRoster: Array.from(agentIdByCode.keys()),
    typeOptions: TOPUP_TYPE_OPTIONS,
  };
  const validationIssues = validateTopUpRows(rows, config);
  const withinFileDupes = detectDuplicatesWithinFile(rows);
  const allIssues = [...validationIssues, ...withinFileDupes];

  const [batch] = await db.insert(schema.importBatches).values({
    product: params.product, importType: 'topup', fileName: params.fileName, uploadedBy: params.uploadedBy,
    rowCount: rows.length, status: 'processing', startedAt: new Date(),
  }).returning({ id: schema.importBatches.id });

  try {
    assertNoBrandErrors(allIssues);

    // Bug fix — this used to hardcode remarks: null, discarding the
    // uploaded Type value entirely. The read side (transactionPageService.ts
    // getTopUpRows) then displayed one fixed literal per product regardless
    // of what the file actually said, so every row looked like the same
    // Type ("Bundle Transfer"/"Internal Transfer") no matter which of
    // TOPUP_TYPE_OPTIONS ('Bundle Transfer In'/'Internal Transfer In'/
    // 'Top Up') was really uploaded. remarks is a generic "6th descriptive
    // field" column — Settlement's free-text Remarks and Top Up's
    // closed-set Type both live in it now, distinguished by transactionType
    // when read.
    const result = await insertTransactionRows(params.product, 'topup', batch.id, rows, allIssues, (row) => ({
      agentName: row.agentName, brand: row.brand, wallet: row.wallet, amount: row.amount, date: row.date,
      // Canonical casing, not whatever the file happened to use — every row
      // reaching here already passed checkTypeField's case-insensitive
      // match (rows that didn't are 'error' and skipped before this runs),
      // so this lookup always finds a match; the fallback is defensive only.
      remarks: TOPUP_TYPE_OPTIONS.find((opt) => opt.toLowerCase() === row.type.trim().toLowerCase()) ?? row.type,
    }), params.excludedRows);

    await db.update(schema.importBatches).set({
      status: 'completed', completedAt: new Date(),
      validCount: result.validCount, duplicateCount: result.duplicateCount, errorCount: result.errorCount,
      errorSummary: JSON.stringify(allIssues.filter((e) => e.type === 'error')),
    }).where(eq(schema.importBatches.id, batch.id));

    return { batchId: batch.id, status: 'completed', rowCount: rows.length, ...result, errors: allIssues };
  } catch (err) {
    await db.update(schema.importBatches).set({ status: 'failed', completedAt: new Date(), errorSummary: err instanceof Error ? err.message : String(err) }).where(eq(schema.importBatches.id, batch.id));
    throw err;
  }
}

// Shared by importSettlementFile/importTopUpFile — both produce
// wallet_transactions rows from the same 5-field shape once `remarks` is
// resolved per-caller (Settlement has real remarks; Top Up's "Type" is
// already captured by transactionType, matching the existing schema
// comment's documented convention).
async function insertTransactionRows<T extends { row: number; agentName: string }>(
  product: Product,
  transactionType: 'settlement' | 'topup',
  batchId: number,
  rows: T[],
  issues: ValidationEntry[],
  extract: (row: T) => { agentName: string; brand: string; wallet: string; amount: string; date: string; remarks: string | null },
  excludedRows?: Set<number>
): Promise<{ validCount: number; duplicateCount: number; errorCount: number; insertedIds: number[]; flaggedDuplicateIds: number[] }> {
  const db = getDb();
  const agentIdByCode = await loadAgentMap(product);
  const brandIdByCode = await loadBrandMap(product);
  let validCount = 0, duplicateCount = 0, errorCount = 0;
  const insertedIds: number[] = [];
  const flaggedDuplicateIds: number[] = [];

  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (excludedRows?.has(row.row)) continue; // user explicitly Skipped this row client-side — excluded, not counted as an error or a duplicate

      const status = classifyRow(row.row, issues);
      if (status === 'error') { errorCount++; continue; } // never insert error rows — server is the final authority, not the client's own prior classification

      const fields = extract(row);
      const agentId = agentIdByCode.get(fields.agentName.trim().toLowerCase());
      if (!agentId) { errorCount++; continue; } // defensive — should already be caught by validation's agent-roster check

      // Defensive only — assertNoBrandErrors() already rejected the whole
      // upload before this loop runs if any row's Brand failed validation,
      // so every row reaching here has already been confirmed to resolve.
      const brandId = brandIdByCode.get(fields.brand.trim().toUpperCase());
      if (!brandId) { errorCount++; continue; }

      const parsedDate = parseImportDate(fields.date);
      const amount = parseAmount(fields.amount);
      if (!parsedDate || isNaN(amount)) { errorCount++; continue; } // defensive — should already be caught by validation

      const occurredOn = formatDateOnly(parsedDate);
      const fingerprint = computeFingerprint(product, transactionType, agentId, brandId, fields.wallet, amount, occurredOn);

      const existing = await tx
        .select({ id: schema.walletTransactions.id })
        .from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.sourceFingerprint, fingerprint))
        .limit(1);
      const flaggedDuplicateOfId = existing[0]?.id ?? null;
      if (flaggedDuplicateOfId) duplicateCount++; else validCount++;

      const [inserted] = await tx.insert(schema.walletTransactions).values({
        product,
        agentId,
        brandId,
        transactionType,
        amount: amount.toFixed(2),
        wallet: fields.wallet || null,
        occurredOn,
        remarks: fields.remarks || null,
        importBatchId: batchId,
        sourceFingerprint: fingerprint,
        flaggedDuplicateOfId,
      }).returning({ id: schema.walletTransactions.id });

      insertedIds.push(inserted.id);
      if (flaggedDuplicateOfId) flaggedDuplicateIds.push(inserted.id);
    }
  });

  return { validCount, duplicateCount, errorCount, insertedIds, flaggedDuplicateIds };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

// Bulk-applies matched-row Opening updates via a single UPDATE...FROM(VALUES)
// statement per chunk, instead of importOpeningFile's old one-UPDATE-per-row
// loop — that per-row pattern was the exact bottleneck the Balance Limit
// investigation's brand-backfill fix also targeted: measured at ~71ms/query
// against the real DB, ~264s extrapolated across Cashout's 3,718 agents
// alone. Unlike Balance Limit's brand backfill (which collapsed onto ~12
// distinct values), every row here has its OWN opening_balance/sdp, so
// there's no small-group collapse available — the real fix is a genuine
// bulk UPDATE with per-row differing values via a VALUES join, chunked at
// 500 rows/statement (same Postgres bound-parameter margin already used for
// Balance Limit's wallet insert).
//
// Split into two functions (not one with a branch) because sdpSkipRows
// rows need a structurally different SET clause (no sdp column touched at
// all) — not just a different value for the same column.
const BULK_UPDATE_CHUNK_SIZE = 500;

type OpeningUpdateWithSdp = { id: number; openingBalance: string; sdp: string };
type OpeningUpdateSkipSdp = { id: number; openingBalance: string };

type OpeningWalletLine = { agentId: number; rawAgentName: string; openingBalance: string; sdp: string };

// Fully replaces (delete, then insert fresh) each touched agent's own
// opening_wallet_lines rows — same replace pattern Balance Limit's own
// import uses for agent_wallets, but on its OWN dedicated table so the two
// upload flows never step on each other's data (see schema.ts's own
// comment on opening_wallet_lines for why this couldn't live on
// agent_wallets). agentIds always covers every agent this upload touched,
// even ones with zero line items this time — a shop that used to be
// multi-wallet but no longer is in this file should lose its stale
// breakdown too.
//
// previousOpeningBalance carry-forward: since this table is delete-then-
// insert (no persistent row identity across uploads), a new line can't just
// read its own old value the way agents' single UPDATE...SET can. Instead,
// the OLD lines are read here before they're deleted, keyed by
// `${agentId}:${walletTypeSuffix}` (BK/NG/RK/UP, via
// extractOpeningWalletTypeSuffix — the same identity Estimated Opening's own
// wallet-line matching already uses), and each new line inherits its
// matching old line's openingBalance. A line whose wallet type didn't exist
// in the previous upload (a genuinely new line) gets null — same "may not
// exist yet" fallback as agents.previousOpeningBalance.
async function replaceOpeningWalletLines(tx: Tx, agentIds: number[], lines: OpeningWalletLine[]): Promise<void> {
  if (agentIds.length === 0) return;
  const uniqueAgentIds = Array.from(new Set(agentIds));

  const previousByKey = new Map<string, string>();
  for (let i = 0; i < uniqueAgentIds.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = uniqueAgentIds.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    const oldLines = await tx
      .select({ agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName, openingBalance: schema.openingWalletLines.openingBalance })
      .from(schema.openingWalletLines)
      .where(inArray(schema.openingWalletLines.agentId, chunk));
    for (const old of oldLines) {
      const suffix = extractOpeningWalletTypeSuffix(old.rawAgentName);
      if (suffix) previousByKey.set(`${old.agentId}:${suffix}`, old.openingBalance);
    }
    await tx.delete(schema.openingWalletLines).where(inArray(schema.openingWalletLines.agentId, chunk));
  }

  const linesWithPrevious = lines.map((line) => {
    const suffix = extractOpeningWalletTypeSuffix(line.rawAgentName);
    const previousOpeningBalance = suffix ? previousByKey.get(`${line.agentId}:${suffix}`) ?? null : null;
    return { ...line, previousOpeningBalance };
  });

  for (let i = 0; i < linesWithPrevious.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = linesWithPrevious.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    await tx.insert(schema.openingWalletLines).values(chunk);
  }
}

// previous_opening_balance = a.opening_balance (the OLD row's value, per
// standard SQL UPDATE...SET semantics — every expression in the SET list
// reads the pre-update row) carries the about-to-be-overwritten Opening
// forward one snapshot deep, in the same atomic statement. See
// agents.previousOpeningBalance's own schema comment for why: Estimated
// Opening's shopRows/walletRows use this as their baseline instead of the
// live column, so a fresh Opening upload doesn't instantly become its own
// estimate's baseline.
async function bulkUpdateOpeningAgentsWithSdp(tx: Tx, updates: OpeningUpdateWithSdp[], now: Date): Promise<void> {
  for (let i = 0; i < updates.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const values = sql.join(chunk.map((u) => sql`(${u.id}::int, ${u.openingBalance}::numeric, ${u.sdp}::numeric)`), sql`, `);
    await tx.execute(sql`
      UPDATE agents AS a
      SET previous_opening_balance = a.opening_balance, opening_balance = v.opening_balance, sdp = v.sdp, is_active = true, last_import_matched_at = ${now}, updated_at = ${now}
      FROM (VALUES ${values}) AS v(id, opening_balance, sdp)
      WHERE a.id = v.id
    `);
  }
}

async function bulkUpdateOpeningAgentsSkipSdp(tx: Tx, updates: OpeningUpdateSkipSdp[], now: Date): Promise<void> {
  for (let i = 0; i < updates.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const values = sql.join(chunk.map((u) => sql`(${u.id}::int, ${u.openingBalance}::numeric)`), sql`, `);
    await tx.execute(sql`
      UPDATE agents AS a
      SET previous_opening_balance = a.opening_balance, opening_balance = v.opening_balance, is_active = true, last_import_matched_at = ${now}, updated_at = ${now}
      FROM (VALUES ${values}) AS v(id, opening_balance)
      WHERE a.id = v.id
    `);
  }
}

// Daily-upload wizard's per-row decision for a row whose Agent Name matched
// nothing existing (importOpeningFile.ts's own agentIdByCode lookup comes up
// empty) — 'insert' confirms it's a genuine new shop (Leader required,
// resolved via the same find-or-create resolveOrCreateLeaderId every other
// Leader assignment in this app already uses); 'link' means the name was a
// typo/variant of an existing shop, so this row's figures should update
// THAT shop instead of creating a duplicate record. Client-gated (BulkImport
// Modal.tsx blocks Continue until every unmatched row has one of these) —
// server stays defensive: a row with neither is treated as an error, same
// stance as every other "client should have already resolved this" case in
// this file.
export type NewShopDecision =
  | { action: 'insert'; leader: string }
  | { action: 'link'; agentCode: string };

// Opening is structurally different — a full roster snapshot (upsert onto
// agents.opening_balance/sdp), not a transaction log. No wallet_transactions
// rows are created; no fingerprint/duplicate-across-history concept applies
// (detectDuplicateAgentNames already covers the only real duplicate
// concern: the same agent appearing twice in ONE uploaded file).
//
// Upsert-by-name, not delete-then-reinsert: a row whose Agent Name already
// matches an existing agent updates that row in place (same id, no history
// loss). A row that matches nothing is either a confirmed new shop (real
// INSERT, via newShopDecisions) or gets linked onto an existing shop the
// user picked manually — see NewShopDecision above.
export async function importOpeningFile(params: { product: Product; file: File; fileName: string; uploadedBy: string; excludedRows?: Set<number>; newShopDecisions?: Record<number, NewShopDecision>; sdpSkipRows?: Set<number> }): Promise<ImportOutcome> {
  // TEMPORARY perf-verification instrumentation — added to confirm the
  // matched-row bulk-update fix below actually collapses import time the
  // same way the Balance Limit brand-backfill fix did. Strip this whole
  // console.time/timeEnd set out once confirmed against a real upload.
  console.time('[Opening] TOTAL');
  const db = getDb();
  console.time('[Opening] parse+map');
  const parsed = await parseWorkbookFile(params.file);
  const rows = mapOpeningRows(parsed, params.product);
  console.timeEnd('[Opening] parse+map');

  console.time('[Opening] fetch roster');
  const agentIdByCode = await loadAgentMap(params.product);
  // Opening-scoped, whitespace-tolerant view over the same roster data —
  // loadAgentMap's own keys (shared with importSettlementFile/
  // importTopUpFile) are left untouched; this re-keys a local copy so a
  // roster agentCode with a stray/non-breaking/double space still matches
  // an uploaded Agent Name that differs only in that whitespace.
  const normalizedAgentIdByCode = new Map<string, number>();
  for (const [code, id] of agentIdByCode) {
    normalizedAgentIdByCode.set(normalizeShopNameForMatch(code), id);
  }

  console.timeEnd('[Opening] fetch roster');

  // Opening = source of truth for shop identity — see buildGhostAgentMap's
  // own header comment. Built once here (not per row), product-scoped,
  // read-only.
  const ghostAgentMap = await buildGhostAgentMap(db, params.product);
  // See buildFamilyLeaderMap's own header comment — used below whenever a
  // brand-new shop's own Leader cell is blank/placeholder, so it inherits
  // its real Leader from a same-family sibling instead. seriesFamilyLeaderMap
  // is the looser fallback (buildSeriesFamilyLeaderMap's own header comment)
  // — whole shop-name series (e.g. every "YUSSOP0xx"), consulted only when
  // the tighter wallet-family map finds nothing.
  const familyLeaderMap = await buildFamilyLeaderMap(db, params.product);
  const seriesFamilyLeaderMap = await buildSeriesFamilyLeaderMap(db, params.product);
  // A same-family sibling's real Leader can also live elsewhere in THIS
  // SAME upload (e.g. "...-ARCANE040-BK" carrying the placeholder while
  // "...-ARCANE040-NG" — a few rows down in the same file — already has the
  // real one) — the file's own row order must not matter, so this scans
  // every row up front (no DB access) before the insert loop runs, rather
  // than only registering a new shop's family the moment IT gets inserted.
  for (const row of rows) {
    const leaderNameRaw = row.leader ?? '';
    if (isPlaceholderLeaderName(leaderNameRaw)) continue;
    const fam = extractRawWalletFamily(row.agentName);
    if (!familyLeaderMap.has(fam)) familyLeaderMap.set(fam, leaderNameRaw);
    const series = extractShopSeriesFamily(row.agentName);
    if (series && !seriesFamilyLeaderMap.has(series)) seriesFamilyLeaderMap.set(series, leaderNameRaw);
  }

  const newShopDecisions = params.newShopDecisions ?? {};
  const sdpSkipRows = params.sdpSkipRows ?? new Set<number>();

  console.time('[Opening] validate rows');
  const validationIssues = validateOpeningRows(rows);
  const withinFileDupes = detectDuplicateAgentNames(rows);
  const allIssues = [...validationIssues, ...withinFileDupes];
  console.timeEnd('[Opening] validate rows');

  const [batch] = await db.insert(schema.importBatches).values({
    product: params.product, importType: 'opening', fileName: params.fileName, uploadedBy: params.uploadedBy,
    rowCount: rows.length, status: 'processing', startedAt: new Date(),
  }).returning({ id: schema.importBatches.id });

  try {
    let validCount = 0, duplicateCount = 0, errorCount = 0;
    const updatedAgentIds: number[] = [];
    // A shop can appear on multiple rows in the same file (per-wallet
    // rows) — reconciliation is per-SHOP, not per-row, so this guards
    // against redundantly re-collecting the same agentId's ghosts within
    // one import. Collected here (pure in-memory Map lookups against the
    // one ghostAgentMap already fetched above, no extra queries) and
    // reconciled in a single batched pass after the row loop — see
    // reconcileGhostsForImport's own header comment for why (was ~2 DB
    // round trips PER GHOST, ~2.7+ minutes of pure query latency on a
    // typical upload; batching cut that to a handful of queries total).
    const reconciledAgentIds = new Set<number>();
    const pendingGhostToTarget = new Map<number, number>();
    // Keyed by agentId (not a plain array) — a shop can legitimately appear
    // on multiple rows in the same file (e.g. one row per wallet, same bare
    // Agent Name repeated with a different Opening Balance each time,
    // confirmed against real uploaded data). Opening Balance is SUMMED
    // across every such row for that shop so none of them get silently
    // discarded; SDP is kept as-is (repeats the same figure every row in
    // practice — shop-level, not per-wallet — so the last one read wins,
    // same as before).
    const matchedWithSdp = new Map<number, OpeningUpdateWithSdp>();
    const matchedSkipSdp = new Map<number, OpeningUpdateSkipSdp>();
    // One opening_wallet_lines row PER FILE ROW that carries a wallet-type
    // suffix (e.g. "-BK") — never deduped/merged, kept completely separate
    // from the shop-level sum above, per explicit instruction ("kada isang
    // row isang opening lang"). No dependency on agent_wallets existing.
    const openingWalletLineInserts: OpeningWalletLine[] = [];

    await db.transaction(async (tx) => {
      console.time('[Opening] row loop (classify + new-shop inserts)');
      for (const row of rows) {
        if (params.excludedRows?.has(row.row)) continue; // user explicitly Skipped this row client-side

        const status = classifyRow(row.row, allIssues);
        if (status === 'error') { errorCount++; continue; }

        const decision = newShopDecisions[row.row];
        // A 'link' decision redirects this row onto a different existing
        // shop than what its own Agent Name would resolve to (the typo/
        // variant case) — everything else still matches by the row's own
        // Agent Name, same as always.
        const targetCode = decision?.action === 'link' ? decision.agentCode : row.agentName;
        const agentId = normalizedAgentIdByCode.get(normalizeShopNameForMatch(targetCode));

        // Blank -> "0.00", not null. Deliberate: for Send Money specifically,
        // this trades away the null-vs-zero distinction
        // getSendMoneyOpeningPgRows()/app/sendmoney/opening's own "No Opening
        // Yet" KPI card (rows.filter(row => row.openingBalance === null))
        // relies on — a blank cell imported through this path is no longer
        // distinguishable from a genuine 0 balance once stored. Confirmed
        // intentional; Cashout's own read side already coerces null to 0 for
        // display regardless, so this is a no-op there.
        const openingBalance = row.openingBalance.trim() === '' ? '0.00' : parseAmount(row.openingBalance).toFixed(2);
        const sdp = row.sdp.trim() === '' ? '0.00' : parseAmount(row.sdp).toFixed(2);

        // A row with genuinely nothing in it (both Opening Balance and SDP
        // are 0) is skipped entirely — no match, no insert, no wallet
        // write. Either figure being non-zero still posts normally, per
        // explicit instruction ("kapag may SDP need mo i-posted").
        if (parseFloat(openingBalance) === 0 && parseFloat(sdp) === 0) continue;

        if (agentId) {
          if (!reconciledAgentIds.has(agentId)) {
            reconciledAgentIds.add(agentId);
            const ghosts = ghostAgentMap.get(targetCode.trim().toUpperCase()) ?? [];
            for (const ghostId of ghosts) {
              if (ghostId !== agentId) pendingGhostToTarget.set(ghostId, agentId);
            }
          }
          if (status === 'duplicate') duplicateCount++; else validCount++;
          // sdpSkipRows (SDP-change confirmation, Phase 2) — the user chose
          // Skip on a large SDP jump for this row: the rest of the row
          // (Opening Balance, lastImportMatchedAt) still applies normally,
          // this just leaves the shop's existing SDP column untouched
          // rather than overwriting it with the uploaded value. Deferred
          // into one of two bulk-update batches below instead of writing
          // immediately — was one UPDATE per row (~71ms/query measured
          // against the real DB, ~264s extrapolated across Cashout's 3,718
          // agents), now a single chunked VALUES-join UPDATE per group.
          if (sdpSkipRows.has(row.row)) {
            const existing = matchedSkipSdp.get(agentId);
            const total = (existing ? parseFloat(existing.openingBalance) : 0) + parseFloat(openingBalance);
            matchedSkipSdp.set(agentId, { id: agentId, openingBalance: total.toFixed(2) });
          } else {
            const existing = matchedWithSdp.get(agentId);
            const total = (existing ? parseFloat(existing.openingBalance) : 0) + parseFloat(openingBalance);
            // SDP is SUMMED across every row for the shop, same treatment
            // as Opening Balance — per explicit instruction, no row gets
            // resolved away or merged, each row's own figure is counted.
            const sdpTotal = (existing ? parseFloat(existing.sdp) : 0) + parseFloat(sdp);
            matchedWithSdp.set(agentId, { id: agentId, openingBalance: total.toFixed(2), sdp: sdpTotal.toFixed(2) });
          }
          // Per-wallet Opening Balance line — if this row's raw Agent Name
          // carried a wallet suffix (captured by mapOpeningRows before
          // normalizeOpeningAgentName stripped it off row.agentName — that
          // field is already bare by the time it reaches here), its OWN
          // figure is recorded as its own line, no existing agent_wallets
          // row required.
          if (row.walletTypeSuffix) {
            openingWalletLineInserts.push({ agentId, rawAgentName: row.rawAgentName, openingBalance, sdp });
          }
          updatedAgentIds.push(agentId);
          continue;
        }

        // No match — auto-inserted as a new shop directly, no manual
        // per-row decision required. A 'link' decision (if the client still
        // sends one) supplies its own Leader; otherwise the row's own
        // Leader column is used, same find-or-create resolution either way.
        // Left as a real per-row insert (not batched) — new shops are a
        // small, bounded count per upload, not worth the added complexity.
        const rawLeaderName = decision?.action === 'insert' ? decision.leader : row.leader;
        // Placeholder ("New-TempAutoPlot"/"NEW SHOP"/blank) defers to a
        // same-family sibling's real Leader when one exists — see
        // buildFamilyLeaderMap's own header comment. Falls through to the
        // looser shop-series map (buildSeriesFamilyLeaderMap) only when the
        // tighter wallet-family match finds nothing. A genuinely different
        // real Leader value the row itself carries is never second-guessed.
        const leaderName = isPlaceholderLeaderName(rawLeaderName)
          ? (familyLeaderMap.get(extractRawWalletFamily(row.agentName))
            ?? seriesFamilyLeaderMap.get(extractShopSeriesFamily(row.agentName) ?? '')
            ?? rawLeaderName)
          : rawLeaderName;
        const leaderId = await resolveOrCreateLeaderId(tx, leaderName);
        const [inserted] = await tx.insert(schema.agents).values({
          product: params.product,
          agentCode: row.agentName,
          leaderId,
          openingBalance,
          sdp,
          lastImportMatchedAt: new Date(),
          updatedAt: new Date(),
        }).returning({ id: schema.agents.id });

        if (status === 'duplicate') duplicateCount++; else validCount++;
        updatedAgentIds.push(inserted.id);
        if (row.walletTypeSuffix) {
          openingWalletLineInserts.push({ agentId: inserted.id, rawAgentName: row.rawAgentName, openingBalance, sdp });
        }
        // Registered so a LATER row in this same file can still 'link' onto
        // the shop this row just created.
        normalizedAgentIdByCode.set(normalizeShopNameForMatch(row.agentName), inserted.id);

        if (!reconciledAgentIds.has(inserted.id)) {
          reconciledAgentIds.add(inserted.id);
          const ghosts = ghostAgentMap.get(row.agentName.trim().toUpperCase()) ?? [];
          for (const ghostId of ghosts) {
            if (ghostId !== inserted.id) pendingGhostToTarget.set(ghostId, inserted.id);
          }
        }
      }
      console.timeEnd('[Opening] row loop (classify + new-shop inserts)');

      console.time('[Opening] ghost reconciliation (batched)');
      await reconcileGhostsForImport(tx, pendingGhostToTarget);
      console.timeEnd('[Opening] ghost reconciliation (batched)');

      console.time('[Opening] bulk update matched rows');
      const matchedAt = new Date();
      await bulkUpdateOpeningAgentsWithSdp(tx, Array.from(matchedWithSdp.values()), matchedAt);
      await bulkUpdateOpeningAgentsSkipSdp(tx, Array.from(matchedSkipSdp.values()), matchedAt);
      await replaceOpeningWalletLines(tx, updatedAgentIds, openingWalletLineInserts);
      console.timeEnd('[Opening] bulk update matched rows');

      // The file is the source of truth: any existing shop this upload
      // never touched (not matched, not freshly inserted) is marked
      // inactive and drops out of the Opening page's display — no manual
      // per-shop "Keep"/"Mark Inactive" review required. Guarded on a
      // non-empty touched set so a file that somehow resolved zero rows
      // can't wipe out the whole roster.
      //
      // Exception (general rule, not a per-shop special case) — a shop
      // absent from THIS Opening file but carrying real DP or WD activity
      // from Balance Limit must stay active: Opening not knowing about a
      // shop yet is not the same as the shop being unreal, and Balance
      // Limit's own auto-create already proved it real. Confirmed live via
      // PHANTOM008/RIAN006 — every Opening re-upload was silently
      // deactivating shops Balance Limit had just (re)confirmed had real
      // money moving through them, hiding them from both Opening and
      // Balance (both pages read the same isActive=true agents set).
      const agentsWithRealActivity = await tx
        .select({ agentId: schema.agentWallets.agentId })
        .from(schema.agentWallets)
        .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
        .where(and(
          eq(schema.agents.product, params.product),
          or(gt(schema.agentWallets.totalDp, '0'), gt(schema.agentWallets.totalWd, '0'))
        ));
      // Guard stays keyed on updatedAgentIds specifically (not the wider
      // keepActiveIds union below) — a file that resolved zero real rows
      // must still be blocked from wiping the roster, exactly as before;
      // the wallet-activity exclusion only narrows what a GENUINE upload
      // is allowed to deactivate, it must never be what allows the
      // deactivation step to run in the first place.
      if (updatedAgentIds.length > 0) {
        const keepActiveIds = Array.from(new Set([...updatedAgentIds, ...agentsWithRealActivity.map((r) => r.agentId)]));
        await tx
          .update(schema.agents)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(
            eq(schema.agents.product, params.product),
            notInArray(schema.agents.id, keepActiveIds),
            eq(schema.agents.isActive, true)
          ));
      }
    });

    await db.update(schema.importBatches).set({
      status: 'completed', completedAt: new Date(), validCount, duplicateCount, errorCount,
      errorSummary: JSON.stringify(allIssues.filter((e) => e.type === 'error')),
    }).where(eq(schema.importBatches.id, batch.id));

    // Running Balance card's trend sparkline — snapshot today's Opening
    // total right after a completed upload (upsert: a same-day re-upload
    // replaces the day's figure rather than duplicating it). Not scoped to
    // isActive — nothing else in the app filters Opening totals by that
    // flag yet either (see agents.is_active's own schema comment).
    const { year, month, day } = manilaFields(getBusinessToday());
    const trendDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const [{ total: openingTotal }] = await db
      .select({ total: sql<string>`coalesce(sum(${schema.agents.openingBalance}), 0)` })
      .from(schema.agents)
      .where(eq(schema.agents.product, params.product));
    await db
      .insert(schema.openingBalanceDaily)
      .values({ product: params.product, trendDate, totalAmount: openingTotal })
      .onConflictDoUpdate({
        target: [schema.openingBalanceDaily.product, schema.openingBalanceDaily.trendDate],
        set: { totalAmount: openingTotal },
      });

    console.timeEnd('[Opening] TOTAL');
    return { batchId: batch.id, status: 'completed', rowCount: rows.length, validCount, duplicateCount, errorCount, insertedIds: updatedAgentIds, flaggedDuplicateIds: [], errors: allIssues };
  } catch (err) {
    await db.update(schema.importBatches).set({ status: 'failed', completedAt: new Date(), errorSummary: err instanceof Error ? err.message : String(err) }).where(eq(schema.importBatches.id, batch.id));
    console.timeEnd('[Opening] TOTAL');
    throw err;
  }
}

export async function getImportBatch(batchId: number) {
  const db = getDb();
  const [batch] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, batchId));
  return batch ?? null;
}

// Phase 4 — "Today's Opening, updated: <timestamp>" signal. import_batches
// already tracks every Opening import attempt (see importOpeningFile above)
// with a server-generated completedAt, so this is a read, not a new table —
// the latest status='completed' row IS the currently-active upload; a
// failed attempt's own row is excluded by the status filter, so it can
// never advance this timestamp even though it still gets its own logged row.
export async function getLatestOpeningImportBatch(product: Product) {
  return getLatestImportBatch(product, 'opening');
}

// Phase 7 — same "latest completed batch IS the active upload" read as
// Opening's own getLatestOpeningImportBatch, generalized over import type.
// Data is stored now (import_batches already carries a real server-generated
// completedAt for every Settlement/Top Up upload via importSettlementFile/
// importTopUpFile above); neither Settlement nor Top Up's page has an
// existing UI slot for a "last import" indicator the way Opening's Estimate
// Mode does, so no new UI element is added for this — display is left for a
// later, separately-scoped change.
export async function getLatestImportBatch(product: Product, importType: 'settlement' | 'topup' | 'opening') {
  const db = getDb();
  const [batch] = await db
    .select()
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.product, product), eq(schema.importBatches.importType, importType), eq(schema.importBatches.status, 'completed')))
    .orderBy(desc(schema.importBatches.completedAt))
    .limit(1);
  return batch ?? null;
}
