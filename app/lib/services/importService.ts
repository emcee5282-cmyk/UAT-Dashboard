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
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { parseWorkbookFile, mapSettlementRows, mapTopUpRows, mapOpeningRows, type SettlementImportRow, type TopUpImportRow, type OpeningImportRow } from '../xlsxParser';
import { validateSettlementRows, parseImportDate, type ValidationEntry, type ValidationConfig } from '../settlementValidation';
import { validateTopUpRows, type TopUpValidationConfig } from '../topupValidation';
import { validateOpeningRows } from '../openingValidation';
import { resolveOrCreateLeaderId } from './openingActionsService';
import { detectDuplicatesWithinFile, detectDuplicateAgentNames } from '../duplicateDetector';
import { classifyRow, calculateImportSummary, calculateOpeningImportSummary } from '../importSummary';
import { parseAmount } from '../format';
import { TOPUP_TYPE_OPTIONS } from '../topupOptions';
import { getBrandsForProduct } from '../db/read/brands';

export type Product = 'cashout' | 'sendmoney';
const WALLET_OPTIONS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];

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

function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  const rows = mapSettlementRows(parsed);
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
  const rows = mapTopUpRows(parsed);
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

async function bulkUpdateOpeningAgentsWithSdp(tx: Tx, updates: OpeningUpdateWithSdp[], now: Date): Promise<void> {
  for (let i = 0; i < updates.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const values = sql.join(chunk.map((u) => sql`(${u.id}::int, ${u.openingBalance}::numeric, ${u.sdp}::numeric)`), sql`, `);
    await tx.execute(sql`
      UPDATE agents AS a
      SET opening_balance = v.opening_balance, sdp = v.sdp, last_import_matched_at = ${now}, updated_at = ${now}
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
      SET opening_balance = v.opening_balance, last_import_matched_at = ${now}, updated_at = ${now}
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
  console.timeEnd('[Opening] fetch roster');

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
    const matchedWithSdp: OpeningUpdateWithSdp[] = [];
    const matchedSkipSdp: OpeningUpdateSkipSdp[] = [];

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
        const agentId = agentIdByCode.get(targetCode.trim().toLowerCase());

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

        if (agentId) {
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
            matchedSkipSdp.push({ id: agentId, openingBalance });
          } else {
            matchedWithSdp.push({ id: agentId, openingBalance, sdp });
          }
          updatedAgentIds.push(agentId);
          continue;
        }

        // No match — only a confirmed 'insert' decision creates a real new
        // shop; anything else here means the client's own New Shops gate
        // didn't actually resolve this row, which shouldn't happen. Left
        // as a real per-row insert (not batched) — new shops are a small,
        // bounded count per upload, not worth the added complexity.
        if (decision?.action !== 'insert') { errorCount++; continue; }

        const leaderId = await resolveOrCreateLeaderId(tx, decision.leader);
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
        // Registered so a LATER row in this same file can still 'link' onto
        // the shop this row just created.
        agentIdByCode.set(row.agentName.trim().toLowerCase(), inserted.id);
      }
      console.timeEnd('[Opening] row loop (classify + new-shop inserts)');

      console.time('[Opening] bulk update matched rows');
      const matchedAt = new Date();
      await bulkUpdateOpeningAgentsWithSdp(tx, matchedWithSdp, matchedAt);
      await bulkUpdateOpeningAgentsSkipSdp(tx, matchedSkipSdp, matchedAt);
      console.timeEnd('[Opening] bulk update matched rows');
    });

    await db.update(schema.importBatches).set({
      status: 'completed', completedAt: new Date(), validCount, duplicateCount, errorCount,
      errorSummary: JSON.stringify(allIssues.filter((e) => e.type === 'error')),
    }).where(eq(schema.importBatches.id, batch.id));

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
