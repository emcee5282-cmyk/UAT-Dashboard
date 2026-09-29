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
import { toBusinessDate, manilaFields } from '../businessDate';
import { subtractDays } from './estimatedWalletCascade';

// Same abbreviation<->full-name mapping balanceService.ts's own
// OPENING_SUFFIX_TO_WALLET_TYPE uses — needed here to match a raw upload
// row's own wallet suffix (BK/NG/RK/UP) against wallet_transactions' full
// wallet name (BKASH/NAGAD/ROCKET/UPAY).
const OPENING_SUFFIX_TO_WALLET_TYPE: Record<string, string> = {
  BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY',
};

const KNOWN_WALLET_TYPES = new Set(['BKASH', 'NAGAD', 'ROCKET', 'UPAY']);
// wallet_transactions.wallet is free-text (typed by whoever uploaded the
// Settlement/Top Up file) and has confirmed live typos ('ROCJET', 'NAGA',
// 'NAGAd') — trim+uppercase normalizes casing but can't fix a typo, so
// anything that still isn't one of the 4 known types is bucketed under
// 'UNMAPPED' rather than silently dropped (see estimated_balance_wallet_totals'
// own schema comment for why this matters for reconciliation).
function normalizeWalletTypeOrUnmapped(raw: string | null): string {
  const upper = (raw ?? '').trim().toUpperCase();
  return KNOWN_WALLET_TYPES.has(upper) ? upper : 'UNMAPPED';
}

export type Product = 'cashout' | 'sendmoney';

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

// Manila business-date 'YYYY-MM-DD' derivation (2 AM reset, see
// businessDate.ts) — was native .getFullYear()/.getMonth()/.getDate(), which
// reads the RUNTIME's own local timezone. On Vercel (UTC) that silently gave
// the UTC calendar date instead of the Manila business date, exactly the bug
// class businessDate.ts's own header comment warns about (confirmed live: a
// cashout upload completed 2026-09-27 02:52 Manila — correctly business day
// 09-27 — was stored as cutoff_date 2026-09-26 under the old getters).
export function toDateOnlyString(date: Date): string {
  const { year, month, day } = manilaFields(toBusinessDate(date));
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

  // Cashout-only file-mismatch guard — per explicit instruction, after a real
  // Send Money file was uploaded to the Cashout endpoint by mistake (its
  // wallet-type column produced 'BKASHC'/'NAGADC'/'ROCKETC'/'UPAYC' instead of
  // the 4 known types, and it only had 132 shop rows against Cashout's normal
  // ~2,300-2,400). Send Money is NOT guarded — per explicit instruction, only
  // Cashout blocks.
  //   1. Every wallet type this file's own DP/WD columns produced
  //      (aggregateByWalletType) must normalize to BKASH/NAGAD/ROCKET/UPAY.
  //      Any other value (a typo, a stray suffix, a wrong-product file) fails
  //      the whole upload — this is the same normalization
  //      normalizeWalletTypeOrUnmapped applies to wallet_transactions, but
  //      here it's a hard reject, not a fallback bucket, because Cashout's own
  //      DP/WD file should never legitimately contain an unrecognized type.
  //   2. Shop count must fall within [1,000, 5,000] — comfortably spans every
  //      real Cashout upload seen (2,316-2,372) with wide margin on both
  //      sides, while rejecting both a tiny/malformed file (upload 29's 132)
  //      and an accidentally-swapped Send Money file (~16,500 shops).
  if (product === 'cashout') {
    const badWalletTypes = walletTotals.map((w) => w.wallet).filter((w) => !KNOWN_WALLET_TYPES.has(w.toUpperCase()));
    if (badWalletTypes.length > 0) {
      throw new Error(
        `Upload rejected: this doesn't look like a Cashout file — found wallet type(s) ${badWalletTypes.join(', ')}, ` +
        `which don't match Bkash/Nagad/Rocket/UPay. Confirm this is the correct Cashout BalanceLimit file.`
      );
    }
    if (shopTotals.length < 1000 || shopTotals.length > 5000) {
      throw new Error(
        `Upload rejected: this file has ${shopTotals.length} shop rows, outside Cashout's expected range (1,000-5,000; ` +
        `typical is ~2,300-2,400). Confirm this is the correct Cashout file, not Send Money's.`
      );
    }
  }

  // Still requires at least one completed Opening import to exist (unchanged
  // precondition) — but per explicit decision, cutoffDate itself is now this
  // UPLOAD's own Manila business date (uploadedAtDate below), not the
  // separate Opening import's own date. Was readLatestOpeningImportCutoffPg's
  // result used directly for cutoffDate — that tied a file's cutoff to
  // whatever Opening import happened to be latest AT UPLOAD TIME, which
  // could silently drift from this upload's own timing (confirmed live: a
  // cashout Estimated Balance upload at 02:52 Manila picked up a LATER,
  // unrelated Opening import from 08:23 Manila the same morning). cutoffDate
  // now means "the business day this Estimated Balance file was uploaded
  // on" — the file's own DP/WD data is understood to represent the day
  // BEFORE that (see this file's own header comment and
  // estimatedWalletCascade.ts's resolveWalletOpening, whose Tier 2 looks up
  // uploads by that same convention).
  const openingImportExists = await readLatestOpeningImportCutoffPg(product);
  if (!openingImportExists) {
    throw new Error(`No completed Opening import found for ${product} yet — upload Opening at least once before uploading Estimated Balance.`);
  }
  const uploadedAtDate = new Date();
  const cutoffDateStr = toDateOnlyString(uploadedAtDate);
  // Top Up/Settlement must describe the SAME activity date as the file's own
  // DP/WD (cutoffDate minus one Manila business day — a file uploaded on
  // cutoffDate always reports the PREVIOUS day's data, e.g. an upload on
  // 09-27 contains "BalanceLimit-2026-09-26"). Per explicit bug report: this
  // used to query wallet_transactions at cutoffDateStr directly (the
  // upload's own posted date), which pulled in a DIFFERENT day's Settlement/
  // TopUp than what the DP/WD actually represents (confirmed live: shop
  // N-B1AG-M5-ATOS004-NG had a real 50,000 settlement dated one day AFTER
  // its DP/WD's own activity date, wrongly deducted from that day's
  // estimate). cutoffDate itself (the upload's own business date, stored on
  // estimatedBalanceUploads.cutoffDate below) is UNCHANGED — only the
  // wallet_transactions filter shifts back one day to match DP/WD.
  const activityDateStr = subtractDays(cutoffDateStr, 1);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentByCode = new Map(agentRows.map((a) => [a.agentCode, a]));

  // Single grouped query for that one activity day's Top Up/Settlement
  // across every agent — not one query per shop (explicit performance
  // requirement). wallet included so a multi-line shop's own per-wallet
  // lines (below) can attribute each wallet's own Top Up/Settlement instead
  // of the whole shop's combined total.
  const txRows = await db
    .select({
      agentId: schema.walletTransactions.agentId,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
    })
    .from(schema.walletTransactions)
    .where(and(eq(schema.walletTransactions.product, product), eq(schema.walletTransactions.occurredOn, activityDateStr)));

  const txByAgentId = new Map<number, { topUp: number; settlement: number }>();
  const txByAgentWallet = new Map<string, { topUp: number; settlement: number }>();
  // Wallet-TYPE-level (not per-agent) Settlement/Top Up for this same cutoff
  // day — snapshotted onto estimated_balance_wallet_totals below so the
  // Wallet Breakdown Estimated card's own Settlement/Topup columns never
  // shift when a transaction is entered later for this date. Reuses txRows
  // (already fetched above for the per-agent maps), no extra query.
  const txByWalletType = new Map<string, { topUp: number; settlement: number }>();
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

    const walletType = normalizeWalletTypeOrUnmapped(t.wallet);
    const typeBucket = txByWalletType.get(walletType) ?? { topUp: 0, settlement: 0 };
    if (t.transactionType === 'topup') typeBucket.topUp += n(t.amount); else typeBucket.settlement += n(t.amount);
    txByWalletType.set(walletType, typeBucket);
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

  type NewEntry = { agentId: number; deposit: number; withdrawal: number; assumedBalance: number; opening: number };
  type NewWalletLineEntry = { agentId: number; walletType: string; deposit: number; withdrawal: number; assumedBalance: number; opening: number };
  const entries: NewEntry[] = [];
  const walletLineInserts: NewWalletLineEntry[] = [];

  for (const s of shopTotals) {
    const agent = agentByCode.get(s.shopName);
    if (!agent) continue; // no matching roster agent — skip, same as the old Postgres mirror's own rejected-row handling, not a hard failure
    const opening = n(agent.openingBalance);
    const openingLines = openingLinesByAgentId.get(agent.id) ?? [];

    if (openingLines.length === 0) {
      // No Opening-defined wallet structure for this shop — whole-shop
      // formula. deposit/withdrawal stored here are the FILE's own DP/WD
      // only, never blended with wallet_transactions — they feed the
      // Estimated tabs' "Total DP"/"Total WD" columns, which sit alongside
      // their OWN dedicated Topup/Settlement-by-type columns
      // (readEstimatedOpeningDisplayPg); blending tx amounts in here too
      // would double-count the exact same money in two columns (confirmed
      // live: AEGIS004's stored withdrawal included a 150,000 settlement
      // that also had its own Settlement column). assumedBalance is a
      // SEPARATE computation that still includes tx.topUp/tx.settlement —
      // it's the complete opening+DP-WD+topUp-settlement figure other
      // consumers (balanceService.ts's Agent Balance Opening override) rely
      // on, and its formula/value is unchanged by this fix.
      const tx = txByAgentId.get(agent.id) ?? { topUp: 0, settlement: 0 };
      const deposit = s.totalDP;
      const withdrawal = s.totalWD;
      const assumedBalance = opening + deposit + tx.topUp - withdrawal - tx.settlement;
      entries.push({ agentId: agent.id, deposit, withdrawal, assumedBalance, opening });
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

    // deposit/withdrawal accumulated here (shopDeposit/shopWithdrawal,
    // lineDeposit/lineWithdrawal) are pure file values — same reasoning as
    // the whole-shop branch above. assumedBalance is tracked via a SEPARATE
    // blended accumulator (shopAssumedBalanceDelta et al.) so its value
    // (opening/lineOpening + fileDP + topUp - fileWD - settlement) is
    // unchanged by this fix, only what gets stored as "deposit"/
    // "withdrawal" changes.
    let shopDeposit = 0;
    let shopWithdrawal = 0;
    let shopDepositBlended = 0;
    let shopWithdrawalBlended = 0;
    for (const line of openingLines) {
      const suffix = extractOpeningWalletTypeSuffix(line.rawAgentName);
      const walletTypeFull = suffix ? OPENING_SUFFIX_TO_WALLET_TYPE[suffix] : null;
      const matched = totalsByOpeningLineId.get(line.id);
      const lineOpening = n(line.openingBalance);
      const walletTx = walletTypeFull ? (txByAgentWallet.get(`${agent.id}:${walletTypeFull}`) ?? { topUp: 0, settlement: 0 }) : { topUp: 0, settlement: 0 };
      const lineDeposit = matched?.totalDP ?? 0;
      const lineWithdrawal = matched?.totalWD ?? 0;
      const lineDepositBlended = lineDeposit + walletTx.topUp;
      const lineWithdrawalBlended = lineWithdrawal + walletTx.settlement;
      shopDeposit += lineDeposit;
      shopWithdrawal += lineWithdrawal;
      shopDepositBlended += lineDepositBlended;
      shopWithdrawalBlended += lineWithdrawalBlended;
      if (walletTypeFull) {
        walletLineInserts.push({ agentId: agent.id, walletType: walletTypeFull, deposit: lineDeposit, withdrawal: lineWithdrawal, assumedBalance: lineOpening + lineDepositBlended - lineWithdrawalBlended, opening: lineOpening });
      }
    }
    entries.push({ agentId: agent.id, deposit: shopDeposit, withdrawal: shopWithdrawal, assumedBalance: opening + shopDepositBlended - shopWithdrawalBlended, opening });
  }
  if (entries.length === 0) {
    throw new Error('None of the uploaded shops matched a known agent — check the file is for the correct product.');
  }

  // Reuses the SAME uploadedAtDate computed above for cutoffDateStr — the
  // stored upload row and the cutoff it was derived from must be the exact
  // same instant, not two separate `new Date()` calls a few queries apart.
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
    const entryRows = entries.map((e) => ({ uploadId: upload.id, agentId: e.agentId, deposit: String(e.deposit), withdrawal: String(e.withdrawal), assumedBalance: String(e.assumedBalance), opening: String(e.opening) }));
    for (let i = 0; i < entryRows.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(schema.estimatedBalanceEntries).values(entryRows.slice(i, i + INSERT_CHUNK_SIZE));
    }

    // Merge the file-based DP/WD (walletTotals, already scoped to known
    // wallet suffixes) with the wallet_transactions-based Settlement/Topup
    // (txByWalletType, which can include 'UNMAPPED') — a wallet type present
    // in either source gets its own row, so a wallet with e.g. Settlement
    // but no file DP/WD activity still gets recorded instead of being
    // dropped for having "nothing" in the file-only map.
    const dpWdByWalletType = new Map(walletTotals.map((w) => [w.wallet, { totalDP: w.totalDP, totalWD: w.totalWD }]));
    const allWalletTypeKeys = new Set([...dpWdByWalletType.keys(), ...txByWalletType.keys()]);
    if (allWalletTypeKeys.size > 0) {
      // Small (at most 5 rows: 4 known wallets + UNMAPPED) — no chunking needed.
      await tx.insert(schema.estimatedBalanceWalletTotals).values(
        Array.from(allWalletTypeKeys).map((walletType) => {
          const dpWd = dpWdByWalletType.get(walletType) ?? { totalDP: 0, totalWD: 0 };
          const txTotals = txByWalletType.get(walletType) ?? { topUp: 0, settlement: 0 };
          return {
            uploadId: upload.id,
            walletType,
            totalDp: String(dpWd.totalDP),
            totalWd: String(dpWd.totalWD),
            settlement: String(txTotals.settlement),
            topup: String(txTotals.topUp),
          };
        })
      );
    }

    if (walletLineInserts.length > 0) {
      // Same chunking, same reason — this one can have MORE rows than
      // estimatedBalanceEntries (one row per wallet line, not per shop).
      const walletLineRows = walletLineInserts.map((l) => ({ uploadId: upload.id, agentId: l.agentId, walletType: l.walletType, deposit: String(l.deposit), withdrawal: String(l.withdrawal), assumedBalance: String(l.assumedBalance), opening: String(l.opening) }));
      for (let i = 0; i < walletLineRows.length; i += INSERT_CHUNK_SIZE) {
        await tx.insert(schema.estimatedBalanceWalletLines).values(walletLineRows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    }
  });

  return { uploadedAt: formatUploadTimestamp(uploadedAtDate), shopCount: shopTotals.length };
}
