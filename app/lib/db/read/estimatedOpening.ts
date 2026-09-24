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
import { and, eq, desc, inArray } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type EstimatedOpeningWalletTotals = { totalDP: number; totalWD: number };

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
    .where(eq(schema.estimatedBalanceUploads.product, product))
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
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd) });

  return { balances, walletLineBalances, walletTotals, uploadedAt: latestUpload.uploadedAt };
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
import { toDateOnlyString } from '../../services/estimatedOpeningService';
import { ESTIMATED_OPENING_EXCLUDED_LEADERS, formatUploadTimestamp } from '../../estimatedOpening';
import { readLatestOpeningImportCutoffPg } from './rosterSyncLog';
import { extractOpeningWalletTypeSuffix } from '../../realShopName';

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
export type EstimatedOpeningShopRow = {
  agentCode: string;
  displayName: string;
  openingBalance: number;
  deposit: number;
  withdrawal: number;
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
    .where(eq(schema.estimatedBalanceUploads.product, product))
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
  for (const w of walletTotalsRows) walletTotals.set(w.walletType, { totalDP: Number(w.totalDp), totalWD: Number(w.totalWd) });

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
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance, leaderName: schema.leaders.name })
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
        .select({ agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName, openingBalance: schema.openingWalletLines.openingBalance })
        .from(schema.openingWalletLines)
        .where(inArray(schema.openingWalletLines.agentId, agentIds))
    : [];
  const linesByAgentId = new Map<number, { rawAgentName: string; openingBalance: string }[]>();
  for (const l of lineRows) {
    if (!linesByAgentId.has(l.agentId)) linesByAgentId.set(l.agentId, []);
    linesByAgentId.get(l.agentId)!.push({ rawAgentName: l.rawAgentName, openingBalance: l.openingBalance });
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

  // Was readRosterCutoffPg (roster_sync_log) — confirmed stuck on a stale
  // date, never updated by any live route. readLatestOpeningImportCutoffPg
  // tracks the real Opening import history instead (import_batches), same
  // fix applied to estimatedOpeningService.ts's own upload-side cutoff.
  const cutoffDate = await readLatestOpeningImportCutoffPg(product);
  const cutoffDateStr = cutoffDate ? toDateOnlyString(cutoffDate) : null;

  const txByAgentCode = new Map<string, { topUp: number; settlement: number }>();
  // Per-wallet too (wallet included) — needed for a split shop's own
  // per-line live fallback (a line the upload didn't cover still needs
  // its OWN Top Up/Settlement, not the whole shop's combined total).
  const txByAgentIdWallet = new Map<string, { topUp: number; settlement: number }>();
  if (cutoffDateStr) {
    const txRows = await db
      .select({ agentId: schema.walletTransactions.agentId, agentCode: schema.agents.agentCode, transactionType: schema.walletTransactions.transactionType, amount: schema.walletTransactions.amount, wallet: schema.walletTransactions.wallet })
      .from(schema.walletTransactions)
      .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
      .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, cutoffDateStr)));
    for (const t of txRows) {
      const bucket = txByAgentCode.get(t.agentCode) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') bucket.topUp += Number(t.amount);
      else bucket.settlement += Number(t.amount);
      txByAgentCode.set(t.agentCode, bucket);

      if (t.wallet) {
        const key = `${t.agentId}:${t.wallet}`;
        const walletBucket = txByAgentIdWallet.get(key) ?? { topUp: 0, settlement: 0 };
        if (t.transactionType === 'topup') walletBucket.topUp += Number(t.amount);
        else walletBucket.settlement += Number(t.amount);
        txByAgentIdWallet.set(key, walletBucket);
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
        const lineOpening = parseFloat(line.openingBalance);
        const walletTx = walletType ? (txByAgentIdWallet.get(`${roster.id}:${walletType}`) ?? { topUp: 0, settlement: 0 }) : { topUp: 0, settlement: 0 };
        const lineDeposit = uploadedLine !== undefined ? uploadedLine.deposit : walletTx.topUp;
        const lineWithdrawal = uploadedLine !== undefined ? uploadedLine.withdrawal : walletTx.settlement;
        const lineEstimated = lineOpening + lineDeposit - lineWithdrawal;

        walletRows.push({ agentCode: roster.agentCode, shopDisplayName, walletDisplayName: line.rawAgentName, openingBalance: lineOpening, deposit: lineDeposit, withdrawal: lineWithdrawal, estimatedBalance: lineEstimated });
        shopRows.push({ agentCode: roster.agentCode, displayName: line.rawAgentName, openingBalance: lineOpening, deposit: lineDeposit, withdrawal: lineWithdrawal, estimatedBalance: lineEstimated });
        rows.push({ agentCode: roster.agentCode, displayName: line.rawAgentName, assumedBalance: lineEstimated });

        shopEstimated += lineEstimated;
      }
      balancesWithFallback.set(roster.agentCode, shopEstimated);
      continue;
    }

    // No Opening-defined wallet structure — whole-shop formula, unchanged.
    // Uses the real uploaded deposit/withdrawal when this upload covered
    // the shop, otherwise the live fallback (opening + today's Top Up −
    // Settlement, no Deposit/Withdrawal component since the upload never
    // reported any).
    const opening = roster.openingBalance === null ? 0 : parseFloat(roster.openingBalance);
    const uploadedDW = uploadedDepositWithdrawalByAgentCode.get(roster.agentCode);
    const tx = txByAgentCode.get(roster.agentCode) ?? { topUp: 0, settlement: 0 };
    const deposit = uploadedDW !== undefined ? uploadedDW.deposit : tx.topUp;
    const withdrawal = uploadedDW !== undefined ? uploadedDW.withdrawal : tx.settlement;
    const assumedBalance = opening + deposit - withdrawal;

    balancesWithFallback.set(roster.agentCode, assumedBalance);
    shopRows.push({ agentCode: roster.agentCode, displayName: shopDisplayName, openingBalance: opening, deposit, withdrawal, estimatedBalance: assumedBalance });
    rows.push({ agentCode: roster.agentCode, displayName: shopDisplayName, assumedBalance });
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
