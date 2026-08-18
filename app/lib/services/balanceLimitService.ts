// Phase 8b — Balance Limit's own server-side upload pipeline. Becomes the
// canonical PostgreSQL source for agent_wallets (Total DP/Total WD/Balance/
// Group [also stored as Account Status — see balanceLimitParser.ts, it's
// derived from Group, never a real input column]/Login/Wallet Type) and,
// downstream, agents.brand_id
// — the same two things scripts/migrate-data.ts's own importAgentWallets()
// already populates from a live Sheets read, now populated instead from a
// real user upload. That script is left completely untouched; this is a new,
// independent write path using the identical resolution logic, not a
// replacement for it.
//
// Shop resolution reuses app/lib/realShopName.ts's extractRealShopName/
// extractSendMoneyShopName UNCHANGED — the exact same functions Estimated
// Opening's own upload (estimatedOpeningService.ts) already trusts. An
// unmatched shop is skipped and reported, never used to create a new agent.
//
// Replace semantics: full delete+replace of agent_wallets per product, one
// transaction — matches importAgentWallets()'s own established "current-
// state snapshot, no natural per-row key" behavior exactly (see that
// function's own comment in migrate-data.ts). This is a real, disclosed
// consequence: uploading a PARTIAL file removes wallet data for any shop
// not present in it, exactly as a partial live-sync run already would.
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { parseWorkbookFile } from '../xlsxParser';
import { mapBalanceLimitRows, type BalanceLimitRow } from '../balanceLimitParser';
import { isValidNumericCell } from '../uploadValidation';
import { resolveBrand, type BrandResolutionConfig } from '../balanceEngine';
import { BRAND_CODES } from '../transferQueueCount';

export type Product = 'cashout' | 'sendmoney';

const CASHOUT_BRAND_CONFIG: BrandResolutionConfig = { brandPriority: BRAND_CODES, brandCodes: BRAND_CODES };
const SENDMONEY_BRAND_CONFIG: BrandResolutionConfig = {
  brandPriority: [...BRAND_CODES, 'SH'],
  brandCodes: [...BRAND_CODES, 'SH'],
  validateComputedBrand: true,
};

const WALLET_TYPE_CODES = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];

// Send Money's own "Bank" values carry a trailing "C" (BKASHC/NAGADC/...)
// that must be stripped before matching WALLET_TYPE_CODES — same per-product
// suffix convention scripts/migrate-data.ts's own resolveWalletTypeCode()
// already documents, reproduced here (not imported — that script is off
// limits to touch or depend on for this phase).
function resolveWalletTypeCode(product: Product, rawBank: string): string {
  const upper = rawBank.trim().toUpperCase();
  return product === 'sendmoney' ? upper.replace(/C$/, '') : upper;
}

export type ValidationEntry = { row: number; shopCode: string; field: string; value: string; issue: string };

export type BalanceLimitImportOutcome = {
  batchId: number;
  status: 'completed' | 'failed';
  rowCount: number;
  validCount: number;
  errorCount: number;
  errors: ValidationEntry[];
};

function n(val: string): number {
  const cleaned = val.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export async function importBalanceLimitFile(params: {
  product: Product;
  file: File;
  fileName: string;
  uploadedBy: string;
}): Promise<BalanceLimitImportOutcome> {
  // TEMPORARY perf-verification instrumentation — added to confirm the
  // brand-backfill N+1 fix below actually collapses the ~5min import time.
  // Strip this whole console.time/timeEnd set out once confirmed against a
  // real upload; not meant to stay in production code long-term.
  console.time('[BalanceLimit] TOTAL');
  const db = getDb();
  console.time('[BalanceLimit] parse+map');
  const parsed = await parseWorkbookFile(params.file);
  // Throws here if the file is missing a required column — before any batch
  // row or write happens, matching every other module's "fail before touch"
  // convention (confirmed in Phase 7's own malformed-upload test).
  const allRows = mapBalanceLimitRows(parsed, params.product);
  // OLD/MANUAL accounts are placeholder/deprecated rows, never real shops
  // (extractRealShopName's own documented convention — the literal 'OLD'/
  // 'MANUAL' return value IS the "not a real identifiable shop" signal).
  // Silently excluded here, before rowCount/validation/import even see
  // them — not flagged as an error, not counted as valid, not inserted.
  const rows = allRows.filter((r) => r.shopCode !== 'OLD' && r.shopCode !== 'MANUAL');
  console.timeEnd('[BalanceLimit] parse+map');

  console.time('[BalanceLimit] fetch roster+wallet types');
  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, params.product));
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode.toLowerCase(), a.id]));

  const walletTypeRows = await db.select({ id: schema.walletTypes.id, code: schema.walletTypes.code }).from(schema.walletTypes);
  const walletTypeIdByCode = new Map(walletTypeRows.map((w) => [w.code, w.id]));
  console.timeEnd('[BalanceLimit] fetch roster+wallet types');

  const [batch] = await db
    .insert(schema.importBatches)
    .values({
      product: params.product,
      importType: 'balancelimit',
      fileName: params.fileName,
      uploadedBy: params.uploadedBy,
      rowCount: rows.length,
      status: 'processing',
      startedAt: new Date(),
    })
    .returning({ id: schema.importBatches.id });

  try {
    console.time('[BalanceLimit] validate rows');
    let validCount = 0;
    let errorCount = 0;
    const errors: ValidationEntry[] = [];
    type NewAgentWallet = typeof schema.agentWallets.$inferInsert;
    const toInsert: NewAgentWallet[] = [];
    const groupsByAgentId = new Map<number, string[]>();

    for (const row of rows) {
      const check = validateRow(row, agentIdByCode);
      if (check) {
        errorCount++;
        errors.push(check);
        continue;
      }
      const agentId = agentIdByCode.get(row.shopCode.toLowerCase())!;
      const walletTypeCode = resolveWalletTypeCode(params.product, row.bank);
      if (row.group && row.group !== '-') {
        (groupsByAgentId.get(agentId) ?? groupsByAgentId.set(agentId, []).get(agentId)!).push(row.group);
      }
      toInsert.push({
        agentId,
        walletTypeId: walletTypeIdByCode.get(walletTypeCode) ?? null,
        accountStatus: row.accountStatus || null,
        groupCode: row.group || null,
        balance: String(n(row.balance)),
        totalDp: String(n(row.totalDP)),
        totalWd: String(n(row.totalWD)),
        isLoggedIn: row.login.toLowerCase() === 'yes',
        updatedAt: new Date(),
      });
      validCount++;
    }
    console.timeEnd('[BalanceLimit] validate rows');

    if (validCount === 0) {
      throw new Error('None of the uploaded rows matched a known agent — check the file is for the correct product.');
    }

    const brandConfig = params.product === 'cashout' ? CASHOUT_BRAND_CONFIG : SENDMONEY_BRAND_CONFIG;
    const INSERT_CHUNK_SIZE = 500; // same Postgres bound-parameter lesson already learned in migrate-data.ts's own importAgentWallets()

    await db.transaction(async (tx) => {
      console.time('[BalanceLimit] delete existing wallets');
      const agentIds = agentRows.map((a) => a.id);
      if (agentIds.length > 0) {
        await tx.delete(schema.agentWallets).where(inArray(schema.agentWallets.agentId, agentIds));
      }
      console.timeEnd('[BalanceLimit] delete existing wallets');

      console.time('[BalanceLimit] insert wallets');
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
        await tx.insert(schema.agentWallets).values(toInsert.slice(i, i + INSERT_CHUNK_SIZE));
      }
      console.timeEnd('[BalanceLimit] insert wallets');

      // Brand backfill — was an N+1 that dominated import time: one
      // SELECT-then-maybe-INSERT (getOrCreateBrandId) PLUS one separate
      // UPDATE, per agent in the FULL roster (not just this upload's rows —
      // resolveBrand() falls back to matching a brand code embedded in the
      // agent's own code even with zero groups, so nearly every agent takes
      // the slow path). Measured against the real DB: ~142ms/agent x 3,718
      // Cashout agents = ~527s alone. Collapsed to: fetch the ~12 existing
      // brand codes once, resolve everything in-memory, then one bulk
      // UPDATE per DISTINCT resolved brand (~12 statements total) instead
      // of one per agent.
      console.time('[BalanceLimit] brand backfill');
      const existingBrandRows = await tx.select({ id: schema.brands.id, code: schema.brands.code }).from(schema.brands).where(eq(schema.brands.product, params.product));
      const brandIdByCode = new Map(existingBrandRows.map((b) => [b.code, b.id]));

      const agentIdsByBrandId = new Map<number, number[]>();
      for (const agent of agentRows) {
        const groups = groupsByAgentId.get(agent.id) ?? [];
        const resolved = resolveBrand(groups, agent.agentCode, brandConfig);
        if (resolved === '−') continue;
        let brandId = brandIdByCode.get(resolved);
        if (brandId === undefined) {
          // Rare — only a genuinely new brand code not already seeded hits
          // this; every already-known code (the common case, ~12 total)
          // resolves straight from the in-memory Map above with no query.
          const created = await getOrCreateBrandId(tx, params.product, resolved);
          if (created === null) continue;
          brandId = created;
          brandIdByCode.set(resolved, brandId);
        }
        const ids = agentIdsByBrandId.get(brandId) ?? [];
        ids.push(agent.id);
        agentIdsByBrandId.set(brandId, ids);
      }

      for (const [brandId, agentIds] of agentIdsByBrandId) {
        await tx.update(schema.agents).set({ brandId }).where(inArray(schema.agents.id, agentIds));
      }
      console.timeEnd('[BalanceLimit] brand backfill');
    });

    await db
      .update(schema.importBatches)
      .set({
        status: 'completed',
        completedAt: new Date(),
        validCount,
        errorCount,
        errorSummary: JSON.stringify(errors),
      })
      .where(eq(schema.importBatches.id, batch.id));

    console.timeEnd('[BalanceLimit] TOTAL');
    return { batchId: batch.id, status: 'completed', rowCount: rows.length, validCount, errorCount, errors };
  } catch (err) {
    await db
      .update(schema.importBatches)
      .set({ status: 'failed', completedAt: new Date(), errorSummary: err instanceof Error ? err.message : String(err) })
      .where(eq(schema.importBatches.id, batch.id));
    console.timeEnd('[BalanceLimit] TOTAL');
    throw err;
  }
}

// OLD/MANUAL rows never reach here — already filtered out of `rows` above,
// before this function is ever called.
function validateRow(row: BalanceLimitRow, agentIdByCode: Map<string, number>): ValidationEntry | null {
  if (!row.shopCode) {
    return { row: row.row, shopCode: row.rawAccount || '(blank)', field: 'Account', value: row.rawAccount, issue: 'Missing or invalid shop code' };
  }
  if (!agentIdByCode.has(row.shopCode.toLowerCase())) {
    return { row: row.row, shopCode: row.shopCode, field: 'Account', value: row.rawAccount, issue: 'No matching agent in roster' };
  }
  if (!isValidNumericCell(row.balance)) {
    return { row: row.row, shopCode: row.shopCode, field: 'Balance', value: row.balance, issue: 'Invalid number format' };
  }
  if (!isValidNumericCell(row.totalDP)) {
    return { row: row.row, shopCode: row.shopCode, field: 'Total DP', value: row.totalDP, issue: 'Invalid number format' };
  }
  if (!isValidNumericCell(row.totalWD)) {
    return { row: row.row, shopCode: row.shopCode, field: 'Total WD', value: row.totalWD, issue: 'Invalid number format' };
  }
  return null;
}

// Find-or-create, matching openingActionsService.ts's own leader/brand
// resolution pattern exactly (onConflictDoNothing + re-select on race) —
// not imported from scripts/migrate-data.ts's own private getOrCreateBrand,
// which is local to that script and off-limits to touch or depend on here.
async function getOrCreateBrandId(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0], product: Product, code: string): Promise<number | null> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed || trimmed === '-') return null;
  const [existing] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.product, product), eq(schema.brands.code, trimmed)));
  if (existing) return existing.id;
  const [inserted] = await tx.insert(schema.brands).values({ product, code: trimmed }).onConflictDoNothing({ target: [schema.brands.product, schema.brands.code] }).returning({ id: schema.brands.id });
  if (inserted) return inserted.id;
  const [raced] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.product, product), eq(schema.brands.code, trimmed)));
  return raced?.id ?? null;
}

export async function getLatestBalanceLimitImportBatch(product: Product) {
  const db = getDb();
  const [batch] = await db
    .select()
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.product, product), eq(schema.importBatches.importType, 'balancelimit'), eq(schema.importBatches.status, 'completed')))
    .orderBy(sql`${schema.importBatches.completedAt} desc`)
    .limit(1);
  return batch ?? null;
}
