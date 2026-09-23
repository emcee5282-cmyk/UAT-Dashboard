// Phase 8b — Balance Limit's own server-side upload pipeline. Becomes the
// canonical PostgreSQL source for agent_wallets (Total DP/Total WD/Balance/
// Status/Group [two independent fields, both real input columns — see
// balanceLimitParser.ts' own header comment for the 2026-08-19 fix; the raw
// file's own "Status" column, not Group, carries accountStatus]/Login/
// Wallet Type) and, downstream, agents.brand_id
// — the same two things scripts/migrate-data.ts's own importAgentWallets()
// already populates from a live Sheets read, now populated instead from a
// real user upload. That script is left completely untouched; this is a new,
// independent write path using the identical resolution logic, not a
// replacement for it.
//
// Shop resolution reuses app/lib/realShopName.ts's extractRealShopName/
// extractSendMoneyShopName UNCHANGED — the exact same functions Estimated
// Opening's own upload (estimatedOpeningService.ts) already trusts.
//
// An unmatched shop code (valid format, no existing agent) is no longer
// always skipped: real DP/WD activity on it means a real shop is missing
// from the roster, so it's auto-created (opening balance 0, no SDP — see
// the row loop's own comment below) rather than silently losing that
// activity. Zero DP/WD activity on an unmatched code still means "not a
// real shop" and is skipped exactly as before — same reasoning OLD/MANUAL
// rows already get, just decided one step later (after the roster is known)
// instead of from the row's own shopCode alone. An EXISTING shop code is
// never affected by this — its wallet data is inserted/replaced exactly as
// it always was, its `agents` roster row (opening balance, SDP, leader) is
// never touched or removed by this import, matched or not, present in this
// file or not.
//
// Replace semantics: full delete+replace of agent_wallets per product, one
// transaction — matches importAgentWallets()'s own established "current-
// state snapshot, no natural per-row key" behavior exactly (see that
// function's own comment in migrate-data.ts). This is a real, disclosed
// consequence: uploading a PARTIAL file removes wallet data for any shop
// not present in it, exactly as a partial live-sync run already would.
import { eq, and, inArray, sql, getTableColumns } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { parseWorkbookFile } from '../xlsxParser';
import { mapBalanceLimitRows, type BalanceLimitRow } from '../balanceLimitParser';
import { isValidNumericCell } from '../uploadValidation';
import { resolveBrand, type BrandResolutionConfig } from '../balanceEngine';
import { BRAND_CODES } from '../transferQueueCount';
import { resolveOrCreateLeaderId } from './openingActionsService';
import { extractShopFamily } from '../realShopName';

// The literal sentinel this whole app understands as "auto-created by the
// Balance Limit upload, not a real roster shop yet" — a real Leader row
// (Leader IS free text server-side, unlike SDP below) so it displays
// correctly everywhere Leader already renders. SDP has no equivalent: it's
// a numeric column, so it stays NULL — every display surface that shows SDP
// keys off Leader === this exact string to render "NEW SHOP" instead of the
// raw null/0 (see app/agentbal/page.tsx and app/sendmoney/balances/
// page.tsx's own sdpDisplay()).
const NEW_SHOP_LEADER_NAME = 'NEW SHOP';

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

  // Family -> real Leader name, so a shop auto-created below (real DP/WD
  // activity, no Opening row yet) gets its actual Leader immediately
  // instead of the "NEW SHOP" placeholder, whenever a sibling shop in the
  // same family (e.g. AVENT001 for a brand-new AVENT500) already has one.
  // Restricted to ACTIVE agents with a real (non-NEW SHOP) leader, so a
  // stale/inactive duplicate or another still-unresolved New Shop can never
  // seed a wrong or placeholder answer. First-wins on a genuine same-family
  // conflict (confirmed against live data: 0 conflicts today) — an
  // intentionally simple tie-break since disagreement here would mean two
  // real shops in the same brand family are already assigned to different
  // leaders, not something this map can safely arbitrate.
  const familyLeaderRows = await db
    .select({ agentCode: schema.agents.agentCode, leaderName: schema.leaders.name })
    .from(schema.agents)
    .innerJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(eq(schema.agents.product, params.product), eq(schema.agents.isActive, true)));
  const leaderNameByFamily = new Map<string, string>();
  for (const r of familyLeaderRows) {
    if (r.leaderName === NEW_SHOP_LEADER_NAME) continue;
    const fam = extractShopFamily(r.agentCode);
    if (!fam || leaderNameByFamily.has(fam)) continue;
    leaderNameByFamily.set(fam, r.leaderName);
  }
  console.timeEnd('[BalanceLimit] fetch roster+wallet types');

  // Step 2 — an unmatched-but-format-valid shop code only gets created when
  // it carries real DP/WD activity SOMEWHERE in this file; a shop whose
  // every row is zero on both is silently excluded, same "not a real
  // record" treatment OLD/MANUAL rows already get above. An EXISTING shop
  // code always survives, regardless of its own DP/WD values (even both 0).
  //
  // CORRECTED 2026-08-20 — this used to be a pre-filter computed once here,
  // BEFORE the transaction loop below, deciding each row's fate against the
  // static pre-upload roster snapshot in isolation. That silently dropped a
  // new shop's OTHER wallet rows whenever the shop had multiple wallets in
  // the file and only SOME of them carried real activity: e.g. a new shop's
  // BKASH row (real WD) got the shop created inside the loop, but its
  // NAGAD row (0/0) had already been thrown out by this filter minutes
  // earlier and never even reached the loop — even though the loop's own
  // per-row check (`if (agentId === undefined) { ...skip only if THIS
  // shop is still unmatched... }`) would have handled it correctly once the
  // shop existed. Confirmed against a real upload (BalanceLimit-2026-08-20.
  // xlsx): DIAMOND004/012/017/020, AGATE001 each lost every wallet but the
  // one with real activity. Fixed by deciding "is this shop worth creating
  // at all" from the shop's AGGREGATE activity across every one of its rows
  // in the file (computed once, up front, order-independent), then letting
  // every row for that shop — regardless of which one happens to be
  // processed first — flow into the loop below and rely on its existing
  // live `agentIdByCode` check (updated as shops get created) to decide
  // whether to skip. The loop's own logic was already correct; only this
  // upstream filter was wrong.
  const hasActivityByUnmatchedShopCode = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.shopCode || agentIdByCode.has(row.shopCode.toLowerCase())) continue; // format error or already-existing shop — not part of this decision
    if (n(row.totalDP) > 0 || n(row.totalWD) > 0) {
      hasActivityByUnmatchedShopCode.set(row.shopCode.toLowerCase(), true);
    }
  }

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
    let validCount = 0;
    let errorCount = 0;
    const errors: ValidationEntry[] = [];
    type NewAgentWallet = typeof schema.agentWallets.$inferInsert;
    const groupsByAgentId = new Map<number, string[]>();
    const brandConfig = params.product === 'cashout' ? CASHOUT_BRAND_CONFIG : SENDMONEY_BRAND_CONFIG;
    const INSERT_CHUNK_SIZE = 500; // same Postgres bound-parameter lesson already learned in migrate-data.ts's own importAgentWallets()
    // Deleted using this pre-loop snapshot only — a shop the loop below
    // creates fresh has no existing wallets to delete anyway, so it must
    // never end up in this list. Existing agents' wallets ARE deleted here
    // (then re-inserted from the file below) — that's the normal, always-
    // intended "sync this shop's real wallet activity" behavior; the "never
    // touch existing shops" rule is about the `agents` roster row (opening
    // balance/SDP/leader), never about `agent_wallets` itself.
    const preExistingAgentIds = agentRows.map((a) => a.id);

    await db.transaction(async (tx) => {
      console.time('[BalanceLimit] validate rows + new-shop inserts');
      const toInsert: NewAgentWallet[] = [];
      for (const row of rows) {
        const check = validateRow(row);
        if (check) {
          errorCount++;
          errors.push(check);
          continue;
        }

        let agentId = agentIdByCode.get(row.shopCode.toLowerCase());
        if (agentId === undefined) {
          // Shop code format is valid but it's not an existing agent (and
          // hasn't already been created by an earlier row for this same
          // shop, this same upload — see hasActivityByUnmatchedShopCode's
          // own comment above). Real DP/WD activity ANYWHERE in this file
          // for this shop means it's genuinely missing from the roster
          // (auto-created below); zero everywhere means this shop isn't
          // worth treating as real at all — skipped silently, same "not a
          // real record" treatment OLD/MANUAL rows already get above,
          // counted in neither validCount nor errorCount. Checked against
          // the shop's aggregate activity, not just this one row's own
          // totalDP/totalWD, so a shop's zero-activity wallet (e.g. its
          // NAGAD row) still gets created once any OTHER row for that same
          // shop (e.g. its BKASH row) proves it's real.
          if (!hasActivityByUnmatchedShopCode.get(row.shopCode.toLowerCase())) continue;

          // Family match (see leaderNameByFamily above) wins over the
          // placeholder whenever a real sibling shop already resolved one —
          // falls back to NEW SHOP only when no sibling exists yet.
          const familyLeaderName = leaderNameByFamily.get(extractShopFamily(row.shopCode) ?? '');
          const leaderId = await resolveOrCreateLeaderId(tx, familyLeaderName ?? NEW_SHOP_LEADER_NAME);
          const [inserted] = await tx.insert(schema.agents).values({
            product: params.product,
            agentCode: row.shopCode,
            leaderId,
            openingBalance: '0.00',
            sdp: null,
            lastImportMatchedAt: new Date(),
            updatedAt: new Date(),
          }).returning({ id: schema.agents.id });
          agentId = inserted.id;
          agentIdByCode.set(row.shopCode.toLowerCase(), agentId);
          // Registered so a LATER row for this same new shop's other wallet
          // (e.g. its NG row after this one's BK) reuses it instead of
          // inserting a duplicate agent, and so brand backfill below (which
          // iterates agentRows) also covers it.
          agentRows.push({ id: agentId, agentCode: row.shopCode });
        }

        const walletTypeCode = resolveWalletTypeCode(params.product, row.bank);
        if (row.group && row.group !== '-') {
          (groupsByAgentId.get(agentId) ?? groupsByAgentId.set(agentId, []).get(agentId)!).push(row.group);
        }
        toInsert.push({
          agentId,
          walletTypeId: walletTypeIdByCode.get(walletTypeCode) ?? null,
          accountStatus: row.accountStatus || null,
          groupCode: row.group || null,
          rawAccount: row.rawAccount || null,
          balance: String(n(row.balance)),
          totalDp: String(n(row.totalDP)),
          totalWd: String(n(row.totalWD)),
          dpLimit: String(n(row.dpLimit)),
          isLoggedIn: row.login.toLowerCase() === 'yes',
          updatedAt: new Date(),
        });
        validCount++;
      }
      console.timeEnd('[BalanceLimit] validate rows + new-shop inserts');

      if (validCount === 0) {
        throw new Error('None of the uploaded rows matched a known agent — check the file is for the correct product.');
      }

      // wallet_status_overrides/wallet_status_history can carry a real,
      // user-set wallet_id (Cashout's per-wallet Priority/Remarks/DP-WD
      // toggles, walletStatusConfigService.ts's resolveTarget()) pointing at
      // an agent_wallets row this upload is about to delete — agent_wallets
      // has no natural per-row key, so every upload deletes and reinserts
      // ALL of a product's wallets (fresh serial ids) rather than updating
      // in place. Before Phase 8's wallet_id FK (migration 0008) existed,
      // that silently orphaned those overrides; now it's FK-enforced (ON
      // DELETE NO ACTION) and blocks the whole delete outright — confirmed
      // live 2026-08-20, a real Cashout upload failed with "Failed query:
      // delete from agent_wallets... foreign key constraint" the moment any
      // deleted wallet had an override pointing at it.
      //
      // Fix: snapshot the full row (overrides) / id (history) plus which
      // (agentId, walletTypeId) its old wallet belonged to, REMOVE the FK
      // reference before deleting (confirmed via a scoped, rolled-back test
      // that snapshotting alone isn't enough — the delete below still hits
      // the same violation unless the reference is actually cleared first),
      // then after the fresh wallets are inserted, re-create/re-point each
      // row at the NEW wallet with that same (agentId, walletTypeId) — same
      // shop + same wallet type, just the new row's id — so a re-upload
      // never silently drops or blocks on someone's manual override.
      //
      // Overrides and history need different removal strategies:
      // - history has no unique constraint on wallet_id, so nulling it in
      //   place (UPDATE) is safe even when one agent has several affected
      //   rows at once.
      // - overrides has a PARTIAL unique index on agentId WHERE wallet_id IS
      //   NULL (wallet_status_overrides_agent_only_uq, Send Money's own
      //   agent-level convention) — nulling two Cashout override rows for
      //   the SAME agent simultaneously (a shop with 2+ wallet-level
      //   overrides, the common case) would collide on that index. DELETE
      //   the old rows outright instead (captured in full first) and
      //   re-INSERT fresh ones after, pointed at the new wallet id — same
      //   net effect, no transient duplicate-NULL state ever exists.
      console.time('[BalanceLimit] snapshot wallet-linked overrides/history');
      const affectedOverrides = preExistingAgentIds.length > 0
        ? await tx
            .select({ ...getTableColumns(schema.walletStatusOverrides), walletTypeId: schema.agentWallets.walletTypeId })
            .from(schema.walletStatusOverrides)
            .innerJoin(schema.agentWallets, eq(schema.walletStatusOverrides.walletId, schema.agentWallets.id))
            .where(inArray(schema.agentWallets.agentId, preExistingAgentIds))
        : [];
      const affectedHistory = preExistingAgentIds.length > 0
        ? await tx
            .select({ id: schema.walletStatusHistory.id, agentId: schema.agentWallets.agentId, walletTypeId: schema.agentWallets.walletTypeId })
            .from(schema.walletStatusHistory)
            .innerJoin(schema.agentWallets, eq(schema.walletStatusHistory.walletId, schema.agentWallets.id))
            .where(inArray(schema.agentWallets.agentId, preExistingAgentIds))
        : [];
      console.timeEnd('[BalanceLimit] snapshot wallet-linked overrides/history');

      if (affectedOverrides.length > 0) {
        await tx.delete(schema.walletStatusOverrides).where(inArray(schema.walletStatusOverrides.id, affectedOverrides.map((r) => r.id)));
      }
      if (affectedHistory.length > 0) {
        await tx.update(schema.walletStatusHistory).set({ walletId: null }).where(inArray(schema.walletStatusHistory.id, affectedHistory.map((r) => r.id)));
      }

      console.time('[BalanceLimit] delete existing wallets');
      if (preExistingAgentIds.length > 0) {
        await tx.delete(schema.agentWallets).where(inArray(schema.agentWallets.agentId, preExistingAgentIds));
      }
      console.timeEnd('[BalanceLimit] delete existing wallets');

      console.time('[BalanceLimit] insert wallets');
      const insertedWallets: { id: number; agentId: number; walletTypeId: number | null }[] = [];
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
        const inserted = await tx
          .insert(schema.agentWallets)
          .values(toInsert.slice(i, i + INSERT_CHUNK_SIZE))
          .returning({ id: schema.agentWallets.id, agentId: schema.agentWallets.agentId, walletTypeId: schema.agentWallets.walletTypeId });
        insertedWallets.push(...inserted);
      }
      console.timeEnd('[BalanceLimit] insert wallets');

      if (affectedOverrides.length > 0 || affectedHistory.length > 0) {
        console.time('[BalanceLimit] re-link wallet-status overrides/history');
        const newWalletIdByKey = new Map<string, number>();
        for (const w of insertedWallets) {
          if (w.walletTypeId === null) continue; // no type resolved for this row — never a re-link target
          newWalletIdByKey.set(`${w.agentId}:${w.walletTypeId}`, w.id);
        }

        const overridesToReinsert: (typeof schema.walletStatusOverrides.$inferInsert)[] = [];
        for (const row of affectedOverrides) {
          const newWalletId = row.walletTypeId === null ? undefined : newWalletIdByKey.get(`${row.agentId}:${row.walletTypeId}`);
          if (newWalletId === undefined) continue; // wallet type no longer present for this shop — nothing left to override
          overridesToReinsert.push({
            agentId: row.agentId,
            walletId: newWalletId,
            depositEnabled: row.depositEnabled,
            withdrawalEnabled: row.withdrawalEnabled,
            priority: row.priority,
            status: row.status,
            remark: row.remark,
            remarkUpdatedBy: row.remarkUpdatedBy,
            remarkUpdatedAt: row.remarkUpdatedAt,
            mainReason: row.mainReason,
            closureType: row.closureType,
            affectedServices: row.affectedServices,
            minimumAmountCanTake: row.minimumAmountCanTake,
            balanceLimitOverride: row.balanceLimitOverride,
            scheduleOverride: row.scheduleOverride,
          });
        }
        if (overridesToReinsert.length > 0) {
          await tx.insert(schema.walletStatusOverrides).values(overridesToReinsert);
        }

        for (const row of affectedHistory) {
          const newWalletId = row.walletTypeId === null ? undefined : newWalletIdByKey.get(`${row.agentId}:${row.walletTypeId}`);
          await tx.update(schema.walletStatusHistory).set({ walletId: newWalletId ?? null }).where(eq(schema.walletStatusHistory.id, row.id));
        }
        console.timeEnd('[BalanceLimit] re-link wallet-status overrides/history');
      }

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

// OLD/MANUAL rows never reach here — already filtered out of `rows` above
// before this function is ever called. Roster membership is not checked
// here at all — an unmatched-but-format-valid shop code is handled by the
// caller's own row-loop logic (auto-create or skip based on the shop's
// aggregate activity across the file), not treated as a validation error.
function validateRow(row: BalanceLimitRow): ValidationEntry | null {
  // Step 1 — Shop Code format. extractRealShopName/extractSendMoneyShopName
  // (realShopName.ts) already ran during mapBalanceLimitRows(); an empty
  // shopCode here means the raw Account string didn't match any of their
  // recognized formats.
  if (!row.shopCode) {
    return { row: row.row, shopCode: row.rawAccount || '(blank)', field: 'Account', value: row.rawAccount, issue: 'Missing or invalid shop code' };
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
  if (!isValidNumericCell(row.dpLimit)) {
    return { row: row.row, shopCode: row.shopCode, field: 'DP Limit', value: row.dpLimit, issue: 'Invalid number format' };
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
