// PostgreSQL read-layer mirror of readCashoutEstimatedOpening() /
// readSendMoneyEstimatedOpening() (app/lib/estimatedOpening.ts, served by
// /api/opening/estimated-balance and /api/sendmoney/opening/estimated-balance).
// NOT wired into any page or route.
//
// Reproduces `balances`, `walletTotals`, and `uploadedAt` exactly — these
// are just the stored upload, stable and fully derivable from Postgres.
//
// Deliberately does NOT reproduce `balancesWithFallback`: the real function
// computes it by blending the stored upload with LIVE Opening/Top Up/
// Settlement figures fetched fresh from Sheets at call time (via
// fetchLiveShopFigures(), itself filtered by a live cutoff-date card).
// Postgres's own agents/wallet_transactions data is a point-in-time
// snapshot from the last migration/sync, not live — computing this field
// against stale data would silently produce a wrong "live" value under a
// key name that looks correct. Returning it wrong would be worse than not
// returning it; this stays a documented gap until Postgres itself becomes
// live-synced.
//
// Also does NOT reproduce the API route's `lastImport` field (sourced from
// a separate readImportLog() call, a different concern from this domain) —
// out of scope for this pass.
import { and, eq, desc, inArray, gte, lte, isNull } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

// settlement/topUp are nullable — NULL means "not captured" (an upload row
// written before this column existed), distinct from a real captured 0.
export type EstimatedOpeningWalletTotals = { totalDP: number; totalWD: number; settlement: number | null; topUp: number | null };

function nOrNull(val: string | null): number | null {
  return val === null ? null : Number(val);
}

export async function readEstimatedOpeningPg(product: Product): Promise<{
  balances: Map<string, number>;
  // Per (agentId, walletType) assumedBalance, keyed "`${agentId}:${walletType}`"
  // — added for balanceService.ts's split Balance page rows (a shop Opening
  // shows as multiple per-wallet rows needs its Estimated Balance override
  // applied PER WALLET LINE, not once per shop; `balances` above only has
  // one shop-level figure, which isn't enough to override an individual
  // line's own Opening value). Sourced from the same latest upload's
  // estimated_balance_wallet_lines — no new calculation, just exposing data
  // that table already has.
  walletLineBalances: Map<string, number>;
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
}> {
  const db = getDb();
  const [latestUpload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(and(eq(schema.estimatedBalanceUploads.product, product), isNull(schema.estimatedBalanceUploads.excludedReason)))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);

  if (!latestUpload) {
    return { balances: new Map(), walletLineBalances: new Map(), walletTotals: new Map(), uploadedAt: null };
  }

  const entries = await db
    .select({ agentCode: schema.agents.agentCode, assumedBalance: schema.estimatedBalanceEntries.assumedBalance })
    .from(schema.estimatedBalanceEntries)
    .innerJoin(schema.agents, eq(schema.estimatedBalanceEntries.agentId, schema.agents.id))
    .where(eq(schema.estimatedBalanceEntries.uploadId, latestUpload.id));

  const walletLineRows = await db
    .select({ agentId: schema.estimatedBalanceWalletLines.agentId, walletType: schema.estimatedBalanceWalletLines.walletType, assumedBalance: schema.estimatedBalanceWalletLines.assumedBalance })
    .from(schema.estimatedBalanceWalletLines)
    .where(eq(schema.estimatedBalanceWalletLines.uploadId, latestUpload.id));

  const walletTotalsRows = await db
    .select()
    .from(schema.estimatedBalanceWalletTotals)
    .where(eq(schema.estimatedBalanceWalletTotals.uploadId, latestUpload.id));

  const balances = new Map<string, number>();
  for (const e of entries) balances.set(e.agentCode, Number(e.assumedBalance));

  const walletLineBalances = new Map<string, number>();
  for (const w of walletLineRows) walletLineBalances.set(`${w.agentId}:${w.walletType}`, Number(w.assumedBalance));

  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd), settlement: nOrNull(w.settlement), topUp: nOrNull(w.topup) });

  return { balances, walletLineBalances, walletTotals, uploadedAt: latestUpload.uploadedAt };
}

// Daily Txn Entry's "Wallet Breakdown Estimated" card (app/api/daily-txn-entry/
// estimated/route.ts) needs a SPECIFIC past day's uploaded wallet totals (the
// upload whose own cutoffDate is that day), not just "whatever the latest
// upload is" like readEstimatedOpeningPg above — its own Opening fallback
// cascade (per explicit spec) is "confirmed closing for D-1, else the
// Estimated value from the upload dated D-1 (recursed for ITS OWN Opening),
// else carry forward" — the middle tier needs this exact-cutoffDate lookup,
// matched on cutoffDate (business date), never upload timestamp. Multiple
// uploads sharing the same cutoffDate resolve to the latest one (uploadedAt
// DESC). Returns null when no upload exists for that exact cutoffDate
// (caller then falls through to its next tier).
export async function readEstimatedOpeningWalletTotalsForCutoff(
  product: Product,
  cutoffDate: string
): Promise<Map<string, EstimatedOpeningWalletTotals> | null> {
  const db = getDb();
  const [upload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(and(
      eq(schema.estimatedBalanceUploads.product, product),
      eq(schema.estimatedBalanceUploads.cutoffDate, cutoffDate),
      isNull(schema.estimatedBalanceUploads.excludedReason)
    ))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);

  if (!upload) return null;

  const rows = await db
    .select()
    .from(schema.estimatedBalanceWalletTotals)
    .where(eq(schema.estimatedBalanceWalletTotals.uploadId, upload.id));

  const totals = new Map<string, EstimatedOpeningWalletTotals>();
  for (const w of rows) totals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd), settlement: nOrNull(w.settlement), topUp: nOrNull(w.topup) });
  return totals;
}

// Batch version of readEstimatedOpeningWalletTotalsForCutoff — every upload
// (and its wallet totals) whose cutoffDate falls in [startDate, endDate], one
// round trip for the uploads + one for their wallet totals, instead of a
// query per date. Backs estimated/route.ts's resolveWalletOpening cascade
// (per explicit instruction: batch-fetch the date range once per request,
// never per recursion level). Multiple uploads sharing a cutoffDate resolve
// to the latest (uploadedAt DESC) — same rule as the single-date version.
export async function readEstimatedOpeningWalletTotalsForCutoffRange(
  product: Product,
  startDate: string,
  endDate: string
): Promise<Map<string, Map<string, EstimatedOpeningWalletTotals>>> {
  const db = getDb();
  const uploads = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(and(
      eq(schema.estimatedBalanceUploads.product, product),
      gte(schema.estimatedBalanceUploads.cutoffDate, startDate),
      lte(schema.estimatedBalanceUploads.cutoffDate, endDate),
      isNull(schema.estimatedBalanceUploads.excludedReason)
    ))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt));

  // First hit per cutoffDate wins — uploads is already ordered uploadedAt DESC.
  const latestUploadByCutoff = new Map<string, { id: number }>();
  for (const u of uploads) {
    if (!latestUploadByCutoff.has(u.cutoffDate)) latestUploadByCutoff.set(u.cutoffDate, { id: u.id });
  }
  if (latestUploadByCutoff.size === 0) return new Map();

  const uploadIds = Array.from(latestUploadByCutoff.values()).map((u) => u.id);
  const uploadIdToCutoff = new Map(Array.from(latestUploadByCutoff.entries()).map(([cutoff, u]) => [u.id, cutoff]));

  const totalsRows = await db
    .select()
    .from(schema.estimatedBalanceWalletTotals)
    .where(inArray(schema.estimatedBalanceWalletTotals.uploadId, uploadIds));

  const result = new Map<string, Map<string, EstimatedOpeningWalletTotals>>();
  for (const w of totalsRows) {
    const cutoff = uploadIdToCutoff.get(w.uploadId);
    if (!cutoff) continue;
    if (!result.has(cutoff)) result.set(cutoff, new Map());
    result.get(cutoff)!.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd), settlement: nOrNull(w.settlement), topUp: nOrNull(w.topup) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3 — full display contract for the Opening estimated-balance GET
// routes (app/api/{opening,sendmoney/opening}/estimated-balance), replacing
// readCashoutEstimatedOpening()/readSendMoneyEstimatedOpening()
// (app/lib/estimatedOpening.ts) for THAT runtime path only. Those Sheets
// functions are left completely unchanged — still used by
// scripts/migrate-data.ts and by the fallback-comparison logic these were
// ported from.
//
// Reproduces `balancesWithFallback` — every roster shop gets a value, not
// just ones in the latest upload — the same computation Phase 2's
// estimatedOpeningService.ts already established for the upload's own
// assumedBalance formula (opening + topUp − settlement, wallet_transactions'
// positive-magnitude sign convention), reused here rather than
// reimplemented, applied to shops the upload didn't cover. A shop already
// present in `balances` is used as-is (Phase 2's write already baked that
// cutoff day's TopUp/Settlement into it — adding it again would double
// count, exactly the same reasoning the old Sheets-based function documented
// for itself).
// ---------------------------------------------------------------------------
import { ESTIMATED_OPENING_EXCLUDED_LEADERS, formatUploadTimestamp } from '../../estimatedOpening';
import { extractOpeningWalletTypeSuffix } from '../../realShopName';
import { TOPUP_TYPE_OPTIONS } from '../../topupOptions';
import { SETTLEMENT_REMARKS_SUGGESTIONS } from '../../settlementOptions';
import { matchTransactionType, zeroedTypeMap } from '../../transactionTypeMatch';
import { subtractDays } from '../../services/estimatedWalletCascade';

// Same abbreviation<->full-name mapping used throughout (balanceService.ts,
// estimatedOpeningService.ts) — needed here to match a stored walletType
// ('BKASH' etc.) back against Opening's own raw line, whose suffix
// (extractOpeningWalletTypeSuffix) comes out as the abbreviation ('BK').
const OPENING_SUFFIX_TO_WALLET_TYPE: Record<string, string> = {
  BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY',
};

export type ImportLogEntry = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

// One display row per shop — or per wallet, for a shop whose Opening lines
// split it (mirrors app/agentbal's own AgentBalanceSplitRow shape/reasoning
// exactly). displayName is always Opening's own raw text when available,
// falling back to the bare agentCode only when Opening has no line at all
// for this shop/wallet. lineId ties a split row back to the specific
// estimated_balance_wallet_lines row it came from (null for a whole-shop
// row) — not currently used for any write-back action, kept for parity
// with the same pattern elsewhere.
export type EstimatedOpeningDisplayRow = { agentCode: string; displayName: string; assumedBalance: number };

// "Per Shop" — exactly one row per Opening shop, never split, per explicit
// spec ("Estimated Balance = Opening Balance + Total Deposit − Total
// Withdrawal", displayed per shop). For a shop Opening also splits into
// wallets, these figures are the SUM of that shop's own wallet-breakdown
// rows below (built bottom-up at write time — see estimatedOpeningService.ts's
// own comment — so this never has to independently reconcile against them).
// topupByType/settlementByType keys are exactly the entries of
// TOPUP_TYPE_OPTIONS/SETTLEMENT_REMARKS_SUGGESTIONS at read time, plus
// OTHER_TYPE_LABEL ('Other') for a remarks value that's NULL, blank, or
// doesn't match any entry (case-insensitive + trimmed — see
// transactionTypeMatch.ts). Every canonical column is always present (zero-
// filled), even when 0 for this shop/day, per explicit spec — the columns
// are driven by those two option lists, never by DISTINCT remarks seen in
// the data. estimatedBalance now includes these:
// opening + deposit - withdrawal + Σ(topupByType) - Σ(settlementByType).
export type EstimatedOpeningShopRow = {
  agentCode: string;
  displayName: string;
  openingBalance: number;
  deposit: number;
  withdrawal: number;
  topupByType: Record<string, number>;
  settlementByType: Record<string, number>;
  estimatedBalance: number;
};

// "Wallet Breakdown" — a SEPARATE table from the per-shop one above, per
// explicit spec ("Create a separate Wallet Breakdown"). One row per
// (shop, wallet) for every shop that has at least one opening_wallet_lines
// row — including a shop with only one wallet (still "a wallet"). A shop
// with zero Opening lines has no rows here at all: Opening never defined a
// wallet-level split for it, so none is invented.
export type EstimatedOpeningWalletRow = {
  agentCode: string;
  shopDisplayName: string;
  walletDisplayName: string;
  openingBalance: number;
  deposit: number;
  withdrawal: number;
  topupByType: Record<string, number>;
  settlementByType: Record<string, number>;
  estimatedBalance: number;
};

export async function readEstimatedOpeningDisplayPg(product: Product): Promise<{
  balances: Map<string, number>;
  balancesWithFallback: Map<string, number>;
  // Deprecated in favor of shopRows/walletRows below (kept only for any
  // caller still reading the older flat shape) — was one row per shop OR
  // one row per wallet for a split shop, mixing the two concepts the spec
  // explicitly asked to keep separate.
  rows: EstimatedOpeningDisplayRow[];
  // The two real outputs per the spec — always query these from here on.
  shopRows: EstimatedOpeningShopRow[];
  walletRows: EstimatedOpeningWalletRow[];
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
  lastImport: ImportLogEntry | null;
}> {
  const db = getDb();
  const [latestUpload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(and(eq(schema.estimatedBalanceUploads.product, product), isNull(schema.estimatedBalanceUploads.excludedReason)))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);

  const emptyResult = { balances: new Map<string, number>(), balancesWithFallback: new Map<string, number>(), rows: [] as EstimatedOpeningDisplayRow[], shopRows: [] as EstimatedOpeningShopRow[], walletRows: [] as EstimatedOpeningWalletRow[], walletTotals: new Map<string, EstimatedOpeningWalletTotals>(), uploadedAt: null, lastImport: null };
  if (!latestUpload) return emptyResult;

  const entries = await db
    .select({ agentCode: schema.agents.agentCode, deposit: schema.estimatedBalanceEntries.deposit, withdrawal: schema.estimatedBalanceEntries.withdrawal, assumedBalance: schema.estimatedBalanceEntries.assumedBalance })
    .from(schema.estimatedBalanceEntries)
    .innerJoin(schema.agents, eq(schema.estimatedBalanceEntries.agentId, schema.agents.id))
    .where(eq(schema.estimatedBalanceEntries.uploadId, latestUpload.id));

  const walletTotalsRows = await db.select().from(schema.estimatedBalanceWalletTotals).where(eq(schema.estimatedBalanceWalletTotals.uploadId, latestUpload.id));

  const balances = new Map<string, number>();
  for (const e of entries) balances.set(e.agentCode, Number(e.assumedBalance));
  const uploadedDepositWithdrawalByAgentCode = new Map<string, { deposit: number; withdrawal: number }>();
  for (const e of entries) uploadedDepositWithdrawalByAgentCode.set(e.agentCode, { deposit: Number(e.deposit), withdrawal: Number(e.withdrawal) });

  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd), settlement: nOrNull(w.settlement), topUp: nOrNull(w.topup) });

  // Every roster shop, with its leader (for the ONEMEN exclusion) —
  // mirrors the old function's own openingByShop/leaderByShop pair.
  // isActive filter added — without it this enumerated every agent row
  // ever created for the product (5,270), including thousands of stale,
  // inactive raw-text duplicate agents left over from before a brand got
  // added to the known-brands list (e.g. old "N-M1AG-S9-ABYSSAL0XX-BK"
  // rows, superseded by the real "ABYSSAL0XX" agent) — each showing up as
  // its own zeroed/stale ghost row on the Estimated Opening (Each Shop)
  // table, same isActive gap already fixed elsewhere this session
  // (getAgentBalances, getCashoutOpeningRows) but missed here.
  const rosterRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance, previousOpeningBalance: schema.agents.previousOpeningBalance, leaderName: schema.leaders.name })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

  // Opening's own raw display name AND per-line opening balance (see
  // displayNames' own doc comment above) — one query for every roster
  // shop's opening_wallet_lines, grouped by agent. This is what decides
  // whether/how a shop splits below — never the upload file's own shape.
  const agentIds = rosterRows.map((r) => r.id);
  const lineRows = agentIds.length > 0
    ? await db
        .select({ agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName, openingBalance: schema.openingWalletLines.openingBalance, previousOpeningBalance: schema.openingWalletLines.previousOpeningBalance })
        .from(schema.openingWalletLines)
        .where(inArray(schema.openingWalletLines.agentId, agentIds))
    : [];
  const linesByAgentId = new Map<number, { rawAgentName: string; openingBalance: string; previousOpeningBalance: string | null }[]>();
  for (const l of lineRows) {
    if (!linesByAgentId.has(l.agentId)) linesByAgentId.set(l.agentId, []);
    linesByAgentId.get(l.agentId)!.push({ rawAgentName: l.rawAgentName, openingBalance: l.openingBalance, previousOpeningBalance: l.previousOpeningBalance });
  }
  // Per-wallet Estimated Opening lines for THIS upload (see
  // estimated_balance_wallet_lines' own schema comment) — only present for
  // a shop/wallet this upload's file actually reported activity for AND
  // whose raw text matched one of Opening's own lines at upload time
  // (estimatedOpeningService.ts's own matching, not re-derived here).
  // Stores walletType, not a name — the display name is resolved fresh
  // below, from Opening's CURRENT opening_wallet_lines (already fetched
  // above as linesByAgentId), every time this is read. Opening owns the
  // name; this table only ever supplies which wallet and how much.
  const walletLineRows = await db
    .select({ agentId: schema.estimatedBalanceWalletLines.agentId, walletType: schema.estimatedBalanceWalletLines.walletType, deposit: schema.estimatedBalanceWalletLines.deposit, withdrawal: schema.estimatedBalanceWalletLines.withdrawal, assumedBalance: schema.estimatedBalanceWalletLines.assumedBalance })
    .from(schema.estimatedBalanceWalletLines)
    .where(eq(schema.estimatedBalanceWalletLines.uploadId, latestUpload.id));
  const walletLinesByAgentId = new Map<number, { walletType: string; deposit: number; withdrawal: number; assumedBalance: number }[]>();
  for (const l of walletLineRows) {
    if (!walletLinesByAgentId.has(l.agentId)) walletLinesByAgentId.set(l.agentId, []);
    walletLinesByAgentId.get(l.agentId)!.push({ walletType: l.walletType, deposit: Number(l.deposit), withdrawal: Number(l.withdrawal), assumedBalance: Number(l.assumedBalance) });
  }

  // The per-shop TopUp/Settlement breakdown must describe the SAME activity
  // date as the file's own DP/WD — latestUpload.cutoffDate minus one Manila
  // business day, never cutoffDate itself. A file uploaded on cutoffDate
  // always reports the PREVIOUS day's data (e.g. an upload on 09-27 contains
  // "BalanceLimit-2026-09-26"), so Settlement/TopUp must be pulled from that
  // same prior day, not the day the file happened to be uploaded on. Per
  // explicit bug report: querying occurredOn = cutoffDate directly (this
  // block's first version) pulled in a real, but WRONG-day, settlement for
  // shop N-B1AG-M5-ATOS004-NG and wrongly deducted it from the estimate.
  // cutoffDate itself is unchanged (still the upload's own posted date, per
  // the earlier explicit rule) — only this wallet_transactions filter shifts
  // back one day. Same subtractDays() estimatedWalletCascade.ts's own
  // resolveWalletOpening already uses, reused rather than reimplemented.
  const cutoffDateStr: string = subtractDays(latestUpload.cutoffDate, 1);

  // Per-shop-per-type breakdown (Estimated Line 1/Line 2's new columns) —
  // whole-shop and per-wallet-line versions (a split shop's line needs its
  // OWN type breakdown, not the whole shop's). Every canonical
  // type from TOPUP_TYPE_OPTIONS/SETTLEMENT_REMARKS_SUGGESTIONS is
  // zero-filled up front so a shop with zero activity for a type still has
  // that key present (matchTransactionType/zeroedTypeMap, see
  // transactionTypeMatch.ts) — never derived from DISTINCT remarks.
  const topupByAgentCodeAndType = new Map<string, Record<string, number>>();
  const settlementByAgentCodeAndType = new Map<string, Record<string, number>>();
  const topupByAgentWalletAndType = new Map<string, Record<string, number>>();
  const settlementByAgentWalletAndType = new Map<string, Record<string, number>>();
  // Rows whose agent is inactive fall outside the roster loop below entirely
  // (rosterRows is isActive=true only) and would otherwise silently vanish —
  // per explicit instruction, tracked separately here and surfaced as an
  // UNMAPPED shop row per wallet (see after the roster loop), same
  // reconciliation convention as the wallet card's own UNMAPPED bucket.
  const unmappedByWalletAndType = new Map<string, { topup: Record<string, number>; settlement: Record<string, number> }>();

  if (cutoffDateStr) {
    const txRows = await db
      .select({
        agentId: schema.walletTransactions.agentId,
        agentCode: schema.agents.agentCode,
        isActive: schema.agents.isActive,
        transactionType: schema.walletTransactions.transactionType,
        amount: schema.walletTransactions.amount,
        wallet: schema.walletTransactions.wallet,
        remarks: schema.walletTransactions.remarks,
      })
      .from(schema.walletTransactions)
      .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
      .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, cutoffDateStr)));

    for (const t of txRows) {
      const amount = Number(t.amount);
      const isTopup = t.transactionType === 'topup';

      if (!t.isActive) {
        // UNMAPPED — this agent is inactive, so it will never be visited by
        // the roster loop below. Bucketed per wallet (needs a real wallet to
        // mean anything); a null-wallet inactive-agent row has nowhere
        // meaningful to attribute and is skipped (none observed live, but
        // guards against a future NULL wallet on an inactive agent's row).
        if (t.wallet) {
          const bucket = unmappedByWalletAndType.get(t.wallet) ?? { topup: zeroedTypeMap(TOPUP_TYPE_OPTIONS), settlement: zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS) };
          const type = matchTransactionType(t.remarks, isTopup ? TOPUP_TYPE_OPTIONS : SETTLEMENT_REMARKS_SUGGESTIONS);
          const target = isTopup ? bucket.topup : bucket.settlement;
          target[type] = (target[type] ?? 0) + amount;
          unmappedByWalletAndType.set(t.wallet, bucket);
        }
        continue;
      }

      const typeMaps = topupByAgentCodeAndType.has(t.agentCode)
        ? { topup: topupByAgentCodeAndType.get(t.agentCode)!, settlement: settlementByAgentCodeAndType.get(t.agentCode)! }
        : { topup: zeroedTypeMap(TOPUP_TYPE_OPTIONS), settlement: zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS) };
      const type = matchTransactionType(t.remarks, isTopup ? TOPUP_TYPE_OPTIONS : SETTLEMENT_REMARKS_SUGGESTIONS);
      (isTopup ? typeMaps.topup : typeMaps.settlement)[type] += amount;
      topupByAgentCodeAndType.set(t.agentCode, typeMaps.topup);
      settlementByAgentCodeAndType.set(t.agentCode, typeMaps.settlement);

      if (t.wallet) {
        const key = `${t.agentId}:${t.wallet}`;
        const walletTypeMaps = topupByAgentWalletAndType.has(key)
          ? { topup: topupByAgentWalletAndType.get(key)!, settlement: settlementByAgentWalletAndType.get(key)! }
          : { topup: zeroedTypeMap(TOPUP_TYPE_OPTIONS), settlement: zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS) };
        (isTopup ? walletTypeMaps.topup : walletTypeMaps.settlement)[type] += amount;
        topupByAgentWalletAndType.set(key, walletTypeMaps.topup);
        settlementByAgentWalletAndType.set(key, walletTypeMaps.settlement);
      }
    }
  }

  const balancesWithFallback = new Map<string, number>();
  const rows: EstimatedOpeningDisplayRow[] = [];
  const shopRows: EstimatedOpeningShopRow[] = [];
  const walletRows: EstimatedOpeningWalletRow[] = [];

  for (const roster of rosterRows) {
    if (ESTIMATED_OPENING_EXCLUDED_LEADERS.includes((roster.leaderName ?? '').trim().toUpperCase())) continue;

    const currentLines = linesByAgentId.get(roster.id) ?? [];
    // Shop-level name is always Opening's own canonical agentCode — never a
    // single wallet line's raw text, even when a shop happens to have
    // exactly one line right now. That "1 line -> show its raw text"
    // branch used to apply here too, but it meant a shop's own name could
    // flip to an ugly raw string (e.g. "N-M2AG-J3-AGATE007-NG") just
    // because Opening's per-wallet line count for it changed between
    // uploads — the shop's real identity, per explicit instruction, is
    // whatever Opening itself assigned as agents.agent_code, never
    // something derived from how many lines currently exist. Each
    // individual WALLET's own row (walletRows below) still shows that
    // line's raw text — that part is correct and unaffected.
    const shopDisplayName = roster.agentCode;

    if (currentLines.length >= 1) {
      // Opening has 1+ wallet lines for this shop. Per explicit instruction
      // ("Estimated Opening (Each Shop)" must match Opening's own file
      // breakdown exactly — a shop that's 2 separate lines in Opening,
      // e.g. AGATE003's own "-BK"/"-NG" rows, must show as 2 separate rows
      // here too, never re-merged into one shop-level total), shopRows now
      // gets ONE ROW PER LINE, same as walletRows below — no more
      // aggregating a multi-line shop into a single combined row. Each
      // line uses its own real upload figure when this upload covered that
      // specific wallet (walletLinesByAgentId), otherwise a live per-wallet
      // fallback (that line's own opening + that wallet's own Top Up/
      // Settlement today).
      //
      // balancesWithFallback (below) is a SEPARATE, still-aggregated
      // per-shop total — other consumers (Balance page's own Estimated
      // Balance column, Dashboard's KPI override) are keyed one-per-agent
      // and must keep summing across a shop's lines; only shopRows (this
      // tab's own "Each Shop" display) changes to per-line.
      const walletLines = walletLinesByAgentId.get(roster.id) ?? [];
      let shopEstimated = 0;
      for (const line of currentLines) {
        const suffix = extractOpeningWalletTypeSuffix(line.rawAgentName);
        const walletType = suffix ? OPENING_SUFFIX_TO_WALLET_TYPE[suffix] : null;
        const uploadedLine = walletType ? walletLines.find((wl) => wl.walletType === walletType) : undefined;
        // previousOpeningBalance (the line's own opening as of the LAST
        // upload before the current one), not the live column — see
        // opening_wallet_lines.previousOpeningBalance's own schema comment.
        // Falls back to the live value only when no previous snapshot
        // exists yet (this line's very first upload since the fix shipped).
        const lineOpening = line.previousOpeningBalance !== null ? parseFloat(line.previousOpeningBalance) : parseFloat(line.openingBalance);
        // deposit/withdrawal no longer fall back to live Top Up/Settlement
        // when the upload didn't cover this line (was walletTx.topUp/
        // walletTx.settlement) — that fallback is now redundant with, and
        // would double-count against, the new topupByType/settlementByType
        // columns below, which already derive from the exact same
        // wallet_transactions rows. deposit/withdrawal are now purely the
        // uploaded file's own figures (0 when uncovered), matching the
        // wallet card's own totalDP/totalWD convention (always pure-file,
        // never live-blended) — the live activity that used to backfill
        // these two fields is fully and more precisely represented by the
        // type columns now.
        const lineDeposit = uploadedLine?.deposit ?? 0;
        const lineWithdrawal = uploadedLine?.withdrawal ?? 0;
        const lineTopupByType = walletType ? (topupByAgentWalletAndType.get(`${roster.id}:${walletType}`) ?? zeroedTypeMap(TOPUP_TYPE_OPTIONS)) : zeroedTypeMap(TOPUP_TYPE_OPTIONS);
        const lineSettlementByType = walletType ? (settlementByAgentWalletAndType.get(`${roster.id}:${walletType}`) ?? zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS)) : zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS);
        const lineTopupTotal = Object.values(lineTopupByType).reduce((s, v) => s + v, 0);
        const lineSettlementTotal = Object.values(lineSettlementByType).reduce((s, v) => s + v, 0);
        const lineEstimated = lineOpening + lineDeposit - lineWithdrawal + lineTopupTotal - lineSettlementTotal;

        walletRows.push({ agentCode: roster.agentCode, shopDisplayName, walletDisplayName: line.rawAgentName, openingBalance: lineOpening, deposit: lineDeposit, withdrawal: lineWithdrawal, topupByType: lineTopupByType, settlementByType: lineSettlementByType, estimatedBalance: lineEstimated });
        shopRows.push({ agentCode: roster.agentCode, displayName: line.rawAgentName, openingBalance: lineOpening, deposit: lineDeposit, withdrawal: lineWithdrawal, topupByType: lineTopupByType, settlementByType: lineSettlementByType, estimatedBalance: lineEstimated });
        rows.push({ agentCode: roster.agentCode, displayName: line.rawAgentName, assumedBalance: lineEstimated });

        shopEstimated += lineEstimated;
      }
      balancesWithFallback.set(roster.agentCode, shopEstimated);
      continue;
    }

    // No Opening-defined wallet structure — whole-shop formula.
    // previousOpeningBalance, not the live column — see
    // agents.previousOpeningBalance's own schema comment. Falls back to the
    // live value only when no previous snapshot exists yet.
    const opening = roster.previousOpeningBalance !== null
      ? parseFloat(roster.previousOpeningBalance)
      : (roster.openingBalance === null ? 0 : parseFloat(roster.openingBalance));
    const uploadedDW = uploadedDepositWithdrawalByAgentCode.get(roster.agentCode);
    // deposit/withdrawal no longer fall back to live Top Up/Settlement (was
    // tx.topUp/tx.settlement) — see the split-shop branch's own comment
    // above for why: that fallback is now redundant with, and would
    // double-count against, topupByType/settlementByType below.
    const deposit = uploadedDW?.deposit ?? 0;
    const withdrawal = uploadedDW?.withdrawal ?? 0;
    const topupByType = topupByAgentCodeAndType.get(roster.agentCode) ?? zeroedTypeMap(TOPUP_TYPE_OPTIONS);
    const settlementByType = settlementByAgentCodeAndType.get(roster.agentCode) ?? zeroedTypeMap(SETTLEMENT_REMARKS_SUGGESTIONS);
    const topupTotal = Object.values(topupByType).reduce((s, v) => s + v, 0);
    const settlementTotal = Object.values(settlementByType).reduce((s, v) => s + v, 0);
    const assumedBalance = opening + deposit - withdrawal + topupTotal - settlementTotal;

    balancesWithFallback.set(roster.agentCode, assumedBalance);
    shopRows.push({ agentCode: roster.agentCode, displayName: shopDisplayName, openingBalance: opening, deposit, withdrawal, topupByType, settlementByType, estimatedBalance: assumedBalance });
    rows.push({ agentCode: roster.agentCode, displayName: shopDisplayName, assumedBalance });
  }

  // UNMAPPED — one synthetic shopRow per wallet with inactive-agent activity
  // (see unmappedByWalletAndType's own comment above), so that money still
  // reconciles into the per-shop total instead of silently vanishing because
  // its shop is off-roster. No real Opening/DP/WD (0/0/0) — its Estimated is
  // purely the net of its own TopUp/Settlement.
  for (const [wallet, byType] of unmappedByWalletAndType) {
    const topupTotal = Object.values(byType.topup).reduce((s, v) => s + v, 0);
    const settlementTotal = Object.values(byType.settlement).reduce((s, v) => s + v, 0);
    if (topupTotal === 0 && settlementTotal === 0) continue;
    const estimatedBalance = topupTotal - settlementTotal;
    shopRows.push({
      agentCode: `UNMAPPED-${wallet}`,
      displayName: `Unmapped (${wallet})`,
      openingBalance: 0,
      deposit: 0,
      withdrawal: 0,
      topupByType: byType.topup,
      settlementByType: byType.settlement,
      estimatedBalance,
    });
  }

  const lastImport: ImportLogEntry = {
    fileName: latestUpload.fileName ?? '',
    shopCount: latestUpload.shopCount ?? entries.length,
    // Same "MM/DD/YYYY HH:MM AM/PM" shape the old Sheets-based Import Log
    // cell text had — BulkImportModal.tsx's parseServerTimestamp() only
    // understands that exact format (see Phase 2's own note on this).
    importedAt: formatUploadTimestamp(latestUpload.uploadedAt),
    importedBy: latestUpload.uploadedBy,
  };

  rows.sort((a, b) => a.agentCode.localeCompare(b.agentCode) || a.displayName.localeCompare(b.displayName));
  shopRows.sort((a, b) => a.agentCode.localeCompare(b.agentCode));
  walletRows.sort((a, b) => a.agentCode.localeCompare(b.agentCode) || a.walletDisplayName.localeCompare(b.walletDisplayName));

  return { balances, balancesWithFallback, rows, shopRows, walletRows, walletTotals, uploadedAt: latestUpload.uploadedAt, lastImport };
}
