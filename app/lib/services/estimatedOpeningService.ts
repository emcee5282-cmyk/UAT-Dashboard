// Postgres-only Estimated Opening upload — no Google Sheets read or write.
// Replaces the old two-stage flow (writeCashoutEstimatedOpening/
// writeSendMoneyEstimatedOpening → syncEstimatedOpeningToPostgres) for the
// upload routes only. Those Sheets-based functions are left fully intact
// (unchanged) — they're still used by the Sheets-mode "Opening" page's own
// GET /api/{opening,sendmoney/opening}/estimated-balance routes and by
// scripts/migrate-data.ts's full migration, neither of which this task
// touches.
//
// Reuses the same pure aggregation/validation logic the old Sheets path
// already relied on (aggregateByShop, aggregateByWalletType — both now
// exported from estimatedOpening.ts, not duplicated) and the same output
// timestamp format (formatUploadTimestamp) so the client UI's display
// logic (formatImportTimestamp, which only parses that exact
// "MM/DD/YYYY HH:MM AM/PM" shape) needs no changes.
//
// Formula (must match writeCashoutEstimatedOpening's/writeSendMoneyEstimated
// Opening's documented formula exactly — only the INPUT SOURCE changes):
//   assumedBalance = openingBalance + uploadedTotalDP - uploadedTotalWD + topUp - settlement
// Sign note: the old Sheets-based formula ADDED settlement because the sheet
// itself stores Settlement as an already-negative number ("kept at its own
// natural sign"). wallet_transactions.amount is always stored as a positive
// magnitude here (sign implied by transaction_type, per that column's own
// schema comment) — so the equivalent net effect requires SUBTRACTING it
// instead, exactly the same translation balanceService.ts's
// computeCompanyBalance() already applies for the live dashboard's own
// Company Balance formula. Verified numerically against the old formula in
// this task's own testing, not just reasoned about.
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { aggregateByShop, aggregateByShopWithLines, aggregateByWalletType, formatUploadTimestamp } from '../estimatedOpening';
import { extractRealShopName, extractSendMoneyShopName, extractOpeningWalletTypeSuffix } from '../realShopName';
import { readLatestOpeningImportCutoffPg } from '../db/read/rosterSyncLog';

// Same abbreviation<->full-name mapping balanceService.ts's own
// OPENING_SUFFIX_TO_WALLET_TYPE uses — needed here to match a raw upload
// row's own wallet suffix (BK/NG/RK/UP) against wallet_transactions' full
// wallet name (BKASH/NAGAD/ROCKET/UPAY).
const OPENING_SUFFIX_TO_WALLET_TYPE: Record<string, string> = {
  BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY',
};

export type Product = 'cashout' | 'sendmoney';

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

// Same Manila-midnight-Date -> 'YYYY-MM-DD' derivation balanceService.ts
// already uses for businessTodayStr, reused here for consistency — both
// values ultimately come from the same manilaMidnight() construction
// (getBusinessToday() / fetchRosterCutoffDate(), see rosterSyncLog.ts).
export function toDateOnlyString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export type EstimatedOpeningUploadResult = { uploadedAt: string; shopCount: number };

export async function importEstimatedOpeningFromUpload(
  product: Product,
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  fileName: string,
  uploadedBy = 'Operations Admin'
): Promise<EstimatedOpeningUploadResult> {
  const db = getDb();

  // Server-side validation + aggregation — throws (findColumn) if the
  // uploaded file is missing a required column; silently excludes any row
  // with a non-numeric DP/WD cell (isValidNumericCell, inside
  // aggregateByShop) — same rules the old Sheets path already enforced,
  // not new ones.
  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;
  const shopTotals = aggregateByShop(headerRow, dataRows, extractShopName);
  const walletTotals = aggregateByWalletType(headerRow, dataRows, product);
  // Same raw rows, kept split by their own raw Account text — only actually
  // used below for a shop whose file rows span 2+ distinct wallets (see
  // estimated_balance_wallet_lines' own schema comment for why).
  const shopLineTotals = aggregateByShopWithLines(headerRow, dataRows, extractShopName);
  if (shopTotals.length === 0) {
    throw new Error('No valid shop rows found in the uploaded file.');
  }

  // Was readRosterCutoffPg (roster_sync_log) — confirmed stuck on a stale
  // date (never updated by any live route, only scripts/migrate-data.ts's
  // one-time historical migration). readLatestOpeningImportCutoffPg tracks
  // the real, live Opening import history (import_batches.completedAt)
  // instead, so Estimated Balance sums THIS product's actual most-recently-
  // uploaded-Opening day's Top Up/Settlement, not a 40-day-old snapshot.
  const cutoffDate = await readLatestOpeningImportCutoffPg(product);
  if (!cutoffDate) {
    throw new Error(`No completed Opening import found for ${product} yet — upload Opening at least once before uploading Estimated Balance.`);
  }
  const cutoffDateStr = toDateOnlyString(cutoffDate);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentByCode = new Map(agentRows.map((a) => [a.agentCode, a]));

  // Single grouped query for that one cutoff day's Top Up/Settlement across
  // every agent — not one query per shop (explicit performance requirement).
  // wallet included so a multi-line shop's own per-wallet lines (below) can
  // attribute each wallet's own Top Up/Settlement instead of the whole
  // shop's combined total.
  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
    })
    .from(schema.walletTransactions)
    .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, cutoffDateStr)));

  const txByAgentId = new Map<number, { topUp: number; settlement: number }>();
  const txByAgentWallet = new Map<string, { topUp: number; settlement: number }>();
  for (const t of txRows) {
    const bucket = txByAgentId.get(t.agentId) ?? { topUp: 0, settlement: 0 };
    if (t.transactionType === 'topup') bucket.topUp += n(t.amount); else bucket.settlement += n(t.amount);
    txByAgentId.set(t.agentId, bucket);

    if (t.wallet) {
      const key = `${t.agentId}:${t.wallet}`;
      const walletBucket = txByAgentWallet.get(key) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') walletBucket.topUp += n(t.amount); else walletBucket.settlement += n(t.amount);
      txByAgentWallet.set(key, walletBucket);
    }
  }

  // Opening's own per-wallet lines decide EVERYTHING about wallet structure
  // below — which shops split, into how many wallets, never how many raw
  // rows this upload's own file happens to have for that shop (that was
  // the actual bug behind SMOKER042: 2 real Opening lines, but only 1
  // covered by a given file, rendering as one combined row — letting the
  // FILE's own shape dictate the display shape instead of Opening's, the
  // exact thing Opening-as-source-of-truth forbids). A shop's own
  // deposit/withdrawal/assumedBalance is ALWAYS the sum of its own
  // wallet-lines' deposit/withdrawal/assumedBalance when it has any lines
  // at all — computed bottom-up, not independently at both levels — so
  // "sum of wallets = shop total" is true by construction, never just by
  // coincidence. A shop with zero Opening lines (no known per-wallet
  // split) keeps the direct whole-shop formula, unchanged.
  const agentIdsFromShopTotals = shopTotals.map((s) => agentByCode.get(s.shopName)?.id).filter((id): id is number => id !== undefined);
  const openingLineRows = agentIdsFromShopTotals.length > 0
    ? await db
        .select({ id: schema.openingWalletLines.id, agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName, openingBalance: schema.openingWalletLines.openingBalance })
        .from(schema.openingWalletLines)
        .where(inArray(schema.openingWalletLines.agentId, agentIdsFromShopTotals))
    : [];
  const openingLinesByAgentId = new Map<number, typeof openingLineRows>();
  for (const l of openingLineRows) {
    if (!openingLinesByAgentId.has(l.agentId)) openingLinesByAgentId.set(l.agentId, []);
    openingLinesByAgentId.get(l.agentId)!.push(l);
  }

  const shopLinesByName = new Map<string, typeof shopLineTotals>();
  for (const l of shopLineTotals) {
    if (!shopLinesByName.has(l.shopName)) shopLinesByName.set(l.shopName, []);
    shopLinesByName.get(l.shopName)!.push(l);
  }

  type NewEntry = { agentId: number; deposit: number; withdrawal: number; assumedBalance: number };
  type NewWalletLineEntry = { agentId: number; walletType: string; deposit: number; withdrawal: number; assumedBalance: number };
  const entries: NewEntry[] = [];
  const walletLineInserts: NewWalletLineEntry[] = [];

  for (const s of shopTotals) {
    const agent = agentByCode.get(s.shopName);
    if (!agent) continue; // no matching roster agent — skip, same as the old Postgres mirror's own rejected-row handling, not a hard failure
    const opening = n(agent.openingBalance);
    const openingLines = openingLinesByAgentId.get(agent.id) ?? [];

    if (openingLines.length === 0) {
      // No Opening-defined wallet structure for this shop — whole-shop
      // formula, unchanged from before.
      const tx = txByAgentId.get(agent.id) ?? { topUp: 0, settlement: 0 };
      const deposit = s.totalDP + tx.topUp;
      const withdrawal = s.totalWD + tx.settlement;
      entries.push({ agentId: agent.id, deposit, withdrawal, assumedBalance: opening + deposit - withdrawal });
      continue;
    }

    // Opening has 1+ lines for this shop — compute each wallet's own
    // deposit/withdrawal first, then derive the shop-level figures as
    // their sum (never computed independently), guaranteeing reconciliation.
    const fileRowsForShop = shopLinesByName.get(s.shopName) ?? [];
    // The upload file can legitimately carry more than one raw row for the
    // SAME wallet (e.g. a shop's "-NG" account split across two rows in
    // the source file) — those must be SUMMED onto one Opening line, never
    // inserted as separate rows (confirmed live: produced a real duplicate
    // "same agent, same raw name" pair, e.g. SMOKER025's own "-NG" line,
    // once from each of 2 file rows).
    const totalsByOpeningLineId = new Map<number, { walletTypeFull: string; totalDP: number; totalWD: number }>();
    for (const rowLine of fileRowsForShop) {
      const suffix = extractOpeningWalletTypeSuffix(rowLine.rawAccount);
      const walletTypeFull = suffix ? OPENING_SUFFIX_TO_WALLET_TYPE[suffix] : null;
      // Matched by comparing THIS row's own wallet suffix against each
      // Opening line's own suffix — only proceeds when Opening already has
      // a line for this exact wallet, so the wallet shown is always
      // genuinely Opening's own, never guessed. A row whose suffix matches
      // no Opening line is excluded from BOTH the wallet split and this
      // shop's own deposit/withdrawal below — keeps the sum-of-wallets
      // invariant exact rather than letting an unrecognized row inflate
      // the shop total beyond what its own known wallets add up to.
      const matchedOpeningLine = walletTypeFull
        ? openingLines.find((ol) => {
            const olSuffix = extractOpeningWalletTypeSuffix(ol.rawAgentName);
            return olSuffix ? OPENING_SUFFIX_TO_WALLET_TYPE[olSuffix] === walletTypeFull : false;
          })
        : undefined;
      if (!matchedOpeningLine || !walletTypeFull) continue;

      const existing = totalsByOpeningLineId.get(matchedOpeningLine.id) ?? { walletTypeFull, totalDP: 0, totalWD: 0 };
      existing.totalDP += rowLine.totalDP;
      existing.totalWD += rowLine.totalWD;
      totalsByOpeningLineId.set(matchedOpeningLine.id, existing);
    }

    let shopDeposit = 0;
    let shopWithdrawal = 0;
    for (const line of openingLines) {
      const suffix = extractOpeningWalletTypeSuffix(line.rawAgentName);
      const walletTypeFull = suffix ? OPENING_SUFFIX_TO_WALLET_TYPE[suffix] : null;
      const matched = totalsByOpeningLineId.get(line.id);
      const lineOpening = n(line.openingBalance);
      const walletTx = walletTypeFull ? (txByAgentWallet.get(`${agent.id}:${walletTypeFull}`) ?? { topUp: 0, settlement: 0 }) : { topUp: 0, settlement: 0 };
      const lineDeposit = (matched?.totalDP ?? 0) + walletTx.topUp;
      const lineWithdrawal = (matched?.totalWD ?? 0) + walletTx.settlement;
      shopDeposit += lineDeposit;
      shopWithdrawal += lineWithdrawal;
      if (walletTypeFull) {
        walletLineInserts.push({ agentId: agent.id, walletType: walletTypeFull, deposit: lineDeposit, withdrawal: lineWithdrawal, assumedBalance: lineOpening + lineDeposit - lineWithdrawal });
      }
    }
    entries.push({ agentId: agent.id, deposit: shopDeposit, withdrawal: shopWithdrawal, assumedBalance: opening + shopDeposit - shopWithdrawal });
  }
  if (entries.length === 0) {
    throw new Error('None of the uploaded shops matched a known agent — check the file is for the correct product.');
  }

  const uploadedAtDate = new Date();

  await db.transaction(async (tx) => {
    const [upload] = await tx
      .insert(schema.estimatedBalanceUploads)
      .values({
        product,
        uploadedBy,
        uploadedAt: uploadedAtDate,
        cutoffDate: cutoffDateStr,
        fileName,
        shopCount: shopTotals.length,
      })
      .returning({ id: schema.estimatedBalanceUploads.id });

    // Chunked — Postgres has a hard 65,535-bound-parameter-per-query limit;
    // estimatedBalanceEntries alone is 5 params/row (uploadId/agentId/
    // deposit/withdrawal/assumedBalance), so a single unchunked insert
    // started failing once a file's shop count grew past ~13,000 (16,231
    // shops × 5 params = 81,155, confirmed live as the exact cause of
    // "Failed query: insert into estimated_balance_entries..."). Same
    // 500-row chunk size already used for this same reason elsewhere in
    // this app (importService.ts's bulkUpdateOpeningAgentsWithSdp,
    // balanceLimitService.ts's own agent_wallets insert).
    const INSERT_CHUNK_SIZE = 500;
    const entryRows = entries.map((e) => ({ uploadId: upload.id, agentId: e.agentId, deposit: String(e.deposit), withdrawal: String(e.withdrawal), assumedBalance: String(e.assumedBalance) }));
    for (let i = 0; i < entryRows.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(schema.estimatedBalanceEntries).values(entryRows.slice(i, i + INSERT_CHUNK_SIZE));
    }

    if (walletTotals.length > 0) {
      // Small (at most 4 rows, one per wallet type) — no chunking needed.
      await tx.insert(schema.estimatedBalanceWalletTotals).values(
        walletTotals.map((w) => ({ uploadId: upload.id, walletType: w.wallet, totalDp: String(w.totalDP), totalWd: String(w.totalWD) }))
      );
    }

    if (walletLineInserts.length > 0) {
      // Same chunking, same reason — this one can have MORE rows than
      // estimatedBalanceEntries (one row per wallet line, not per shop).
      const walletLineRows = walletLineInserts.map((l) => ({ uploadId: upload.id, agentId: l.agentId, walletType: l.walletType, deposit: String(l.deposit), withdrawal: String(l.withdrawal), assumedBalance: String(l.assumedBalance) }));
      for (let i = 0; i < walletLineRows.length; i += INSERT_CHUNK_SIZE) {
        await tx.insert(schema.estimatedBalanceWalletLines).values(walletLineRows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    }
  });

  return { uploadedAt: formatUploadTimestamp(uploadedAtDate), shopCount: shopTotals.length };
}
