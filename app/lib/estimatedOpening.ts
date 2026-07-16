import { google, Auth } from 'googleapis';
import { extractRealShopName, extractSendMoneyShopName } from './realShopName';
import { fetchRange } from './googleSheets';
import { BRAND_CODES } from './transferQueueCount';
import { getBusinessToday, toManilaWallClock, fromManilaWallClockMs, parseCardCutoffDate } from './businessDate';

// "Estimated Opening" — a dedicated sheet tab (in the same spreadsheet as
// everything else) that holds a raw upload of "assumed balance" data used
// only during the gap between day-transition (2AM business-day rollover,
// see app/lib/businessDate.ts) and the real Opening Balance actually
// refreshing for the new day. Read-side validity/formula logic is a
// separate follow-up — this file only owns writing the upload.
const SHEET_TITLE = 'Estimated Opening';

// Cashout's shop table lives in columns A-B; Send Money's own block starts
// at column M, directly after Cashout's own blocks (A-K, see
// WALLET_TOTALS_START_COL/IMPORT_LOG_START_COL below), with the same
// 1-column gap convention used between Cashout's own blocks.
const CASHOUT_START_COL = 'A';
const SENDMONEY_START_COL = 'M';
// Per-wallet-type (Bkash/Nagad/Rocket/Upay) Total DP/Total WD breakdown from
// the upload — lives in its own columns within the same Cashout block so it
// doesn't disturb the Agent Name/Assumed Balance table's existing shape
// (kept for easy side-by-side cross-checking, per earlier instruction).
const WALLET_TOTALS_START_COL = 'D';
// Import history log — its own column block (H-K), side-by-side with the
// shop table (A-B) and Wallet Totals (D-F) rather than stacked below either
// one. Holds only the single most recent upload — overwritten in place each
// time, never grown by adding rows — this is the shared, cross-device "proof
// of last upload" the sheet-only Estimated Opening data didn't have on its
// own (a browser-local record can't answer "did the other staff member
// actually upload it").
const IMPORT_LOG_START_COL = 'H';
const IMPORT_LOG_END_COL = 'K';
const IMPORT_LOG_TITLE_ROW = 1;
const IMPORT_LOG_HEADER_ROW = 2;
const IMPORT_LOG_FIRST_DATA_ROW = 3;

// Send Money's block — same relative layout as Cashout's own (shop table 2
// cols, 1-col gap, Wallet Totals 3 cols, 1-col gap, Import Log 4 cols), just
// starting at M instead of A: shop table M-N, Wallet Totals P-R, Import Log
// T-W. Reuses the SAME "Estimated Opening" tab (no new sheet) per explicit
// instruction.
const SENDMONEY_WALLET_TOTALS_START_COL = 'P';
const SENDMONEY_IMPORT_LOG_START_COL = 'T';
const SENDMONEY_IMPORT_LOG_END_COL = 'W';
// No auth system exists in this app — kept as a static label, same as the
// upload modal's own client-side copy of this constant.
const IMPORTED_BY = 'Operations Admin';

// Full read-write scope — separate from app/lib/googleSheets.ts's
// read-only client, since this is the only feature in the app that writes
// back to the spreadsheet.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _auth: Auth.JWT | null = null;

function getAuthClient(): Auth.JWT {
  if (_auth) return _auth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error(
      'Missing Google service account credentials. ' +
      'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env.local.'
    );
  }

  _auth = new google.auth.JWT({ email, key: privateKey, scopes: SCOPES });
  return _auth;
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('Missing GOOGLE_SHEET_ID in .env.local.');
  return id;
}

// "MM/DD/YYYY HH:MM AM/PM", e.g. "07/15/2026 02:14 AM" — this sheet's own
// timestamp convention (deliberately more explicit than the "Month Day - H:MM
// AM/PM" card format the "Opening AG" sheet already uses elsewhere).
// Written in Manila wall-clock time (see app/lib/businessDate.ts) — NOT the
// server runtime's own local time (Vercel defaults to UTC), otherwise an
// upload made at, say, 2 AM Manila gets logged as "6 PM the previous day."
function formatUploadTimestamp(date: Date): string {
  const manila = toManilaWallClock(date);
  const mm = String(manila.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(manila.getUTCDate()).padStart(2, '0');
  const yyyy = manila.getUTCFullYear();
  let hours = manila.getUTCHours();
  const minutes = String(manila.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hh = String(hours).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${minutes} ${ampm}`;
}

function findColumn(headerRow: (string | number)[], label: string): number {
  const idx = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === label.toLowerCase());
  if (idx === -1) {
    throw new Error(`Uploaded file is missing an expected "${label}" column.`);
  }
  return idx;
}

function parseNumber(val: string | number | undefined | null): number {
  if (typeof val === 'number') return val;
  const cleaned = String(val ?? '').replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// "AG BD STLM + TOPUP" dates are formatted "M/D/YYYY".
function parseStlmRowDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

type LiveShopFigures = {
  openingByShop: Map<string, number>;
  topUpByShop: Map<string, number>;
  stlmByShop: Map<string, number>;
};

// Reads the same two live sheets app/agentbal/page.tsx already reads for
// Company Balance — "Opening AG" (Opening Balance per shop) and "AG BD STLM
// + TOPUP" (this reset period's Top Up/Settlement per shop, cutoff-date
// filtered) — so the Assumed Balance formula below can substitute the
// upload's Total DP/Total WD for the live Balance Limit sheet's own
// (not-yet-reset) figures while keeping Opening/TopUp/Settlement live.
async function fetchLiveShopFigures(): Promise<LiveShopFigures> {
  const [openingRows, stlmRows] = await Promise.all([
    fetchRange('Opening AG'),
    fetchRange('AG BD STLM + TOPUP'),
  ]);

  // Shop-name keys are normalized to uppercase on both sides of every
  // lookup below — extractRealShopName() (used upstream to key shopTotals)
  // always produces an uppercase code by construction (its regexes only
  // capture [A-Z]+[0-9]+), but "AG BD STLM + TOPUP"'s own "To Agent" column
  // sometimes carries inconsistent casing (e.g. "Clove003" next to
  // "SATAN002") — an exact-case Map lookup silently dropped those rows,
  // undercounting Settlement for any shop whose name wasn't already
  // all-caps in the sheet.
  const openingByShop = new Map<string, number>();
  openingRows.slice(1).forEach((row) => {
    const agentName = (row[0] ?? '').trim();
    if (!agentName || agentName === '-' || agentName === 'OLD') return;
    openingByShop.set(agentName.toUpperCase(), parseNumber(row[1]));
  });

  // Top Up/Settlement totals reset at the 2AM business-day rollover (see
  // app/lib/businessDate.ts) — clock-based, not gated on whether Opening's
  // own "Updated Time" card has been manually refreshed yet.
  const reportCutoffDate = getBusinessToday();

  const topUpByShop = new Map<string, number>();
  const stlmByShop = new Map<string, number>();
  stlmRows.slice(1).forEach((row) => {
    // Top Up cols B-F (idx 1-5): idx1=agent, idx2=amount, idx3=date
    const topUpAgent = stripBrandSuffix((row[1] ?? '').trim()).toUpperCase();
    const topUpAmount = (row[2] ?? '').trim();
    const topUpDate = reportCutoffDate ? parseStlmRowDate((row[3] ?? '').trim()) : null;
    if (
      topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
      (!reportCutoffDate || (topUpDate && topUpDate >= reportCutoffDate))
    ) {
      const amount = Math.abs(parseNumber(topUpAmount));
      topUpByShop.set(topUpAgent, (topUpByShop.get(topUpAgent) ?? 0) + amount);
    }

    // Settlement cols H-L (idx 7-11): idx7=agent, idx8=amount (stored
    // negative — abs()'d before use), idx9=date
    const stlmAgent = stripBrandSuffix((row[7] ?? '').trim()).toUpperCase();
    const stlmAmount = (row[8] ?? '').trim();
    const stlmDate = reportCutoffDate ? parseStlmRowDate((row[9] ?? '').trim()) : null;
    if (
      stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
      (!reportCutoffDate || (stlmDate && stlmDate >= reportCutoffDate))
    ) {
      const amount = Math.abs(parseNumber(stlmAmount));
      stlmByShop.set(stlmAgent, (stlmByShop.get(stlmAgent) ?? 0) + amount);
    }
  });

  return { openingByShop, topUpByShop, stlmByShop };
}

type ShopTotals = { shopName: string; totalDP: number; totalWD: number };

// Aggregates raw wallet-level rows (one row per Bkash/Nagad/Rocket/Upay
// account, per extractRealShopName's own comment) into one row per real
// shop, summing Total DP (deposit) / Total WD (withdrawal) across a shop's
// multiple wallet-type rows — same grouping pattern used everywhere else in
// this app (e.g. app/page.tsx's agentTotals map). "OLD"/unextractable shop
// names are excluded, matching the `!== 'OLD'` roster filter used elsewhere.
// extractShopName defaults to Cashout's own formula (extractRealShopName);
// Send Money's upload uses its own, completely different formula
// (extractSendMoneyShopName) — the two products' Account/Wallet Name columns
// don't share a naming convention.
function aggregateByShop(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  extractShopName: (raw: string | number | undefined | null) => string = extractRealShopName
): ShopTotals[] {
  const accountCol = findColumn(headerRow, 'Account');
  const dpCol = findColumn(headerRow, 'Total DP');
  const wdCol = findColumn(headerRow, 'Total WD');

  const totals = new Map<string, { totalDP: number; totalWD: number }>();
  for (const row of dataRows) {
    const shopName = extractShopName(row[accountCol]);
    if (!shopName || shopName === 'OLD') continue;
    const existing = totals.get(shopName) ?? { totalDP: 0, totalWD: 0 };
    existing.totalDP += parseNumber(row[dpCol]);
    existing.totalWD += parseNumber(row[wdCol]);
    totals.set(shopName, existing);
  }

  return Array.from(totals.entries())
    .map(([shopName, t]) => ({ shopName, ...t }))
    .sort((a, b) => a.shopName.localeCompare(b.shopName));
}

type WalletTypeTotals = { wallet: string; totalDP: number; totalWD: number };

// Aggregates the same raw wallet-level rows as aggregateByShop, but grouped
// by the upload's own "Bank" column (NAGAD/BKASH/ROCKET/UPAY per row)
// instead of by shop — feeds the Wallet Breakdown's per-wallet Assumed
// Running Balance on Balance Overview.
function aggregateByWalletType(headerRow: (string | number)[], dataRows: (string | number)[][]): WalletTypeTotals[] {
  const bankCol = findColumn(headerRow, 'Bank');
  const dpCol = findColumn(headerRow, 'Total DP');
  const wdCol = findColumn(headerRow, 'Total WD');

  const totals = new Map<string, { totalDP: number; totalWD: number }>();
  for (const row of dataRows) {
    const wallet = String(row[bankCol] ?? '').trim().toUpperCase();
    if (!wallet) continue;
    const existing = totals.get(wallet) ?? { totalDP: 0, totalWD: 0 };
    existing.totalDP += parseNumber(row[dpCol]);
    existing.totalWD += parseNumber(row[wdCol]);
    totals.set(wallet, existing);
  }

  return Array.from(totals.entries())
    .map(([wallet, t]) => ({ wallet, ...t }))
    .sort((a, b) => a.wallet.localeCompare(b.wallet));
}

export type ImportLogEntry = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

// Writes the (idempotent, always-the-same) title/header for the import log
// block, then overwrites the single data row (IMPORT_LOG_FIRST_DATA_ROW) with
// this upload — no row insertion, so the sheet never grows. startCol/endCol
// let Cashout (H-K) and Send Money (T-W) share this same logic against
// their own column blocks.
async function appendImportLogEntry(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  startCol: string,
  endCol: string,
  entry: { fileName: string; shopCount: number }
): Promise<string> {
  const importedAt = formatUploadTimestamp(new Date());

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}${IMPORT_LOG_TITLE_ROW}:${endCol}${IMPORT_LOG_HEADER_ROW}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['IMPORT LOG'],
        ['File Name', 'Shop Count', 'Imported At', 'Imported By'],
      ],
    },
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}${IMPORT_LOG_FIRST_DATA_ROW}:${endCol}${IMPORT_LOG_FIRST_DATA_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[entry.fileName, entry.shopCount, importedAt, IMPORTED_BY]] },
  });

  return importedAt;
}

/**
 * Reads the import log back out — just the single most-recent-upload row
 * (overwritten in place, never grown). Read-only. Returns an empty array if
 * the sheet/tab or log block doesn't exist yet (nothing imported through
 * this modal yet). Defaults to Cashout's own block (H-K); Send Money reads
 * via readSendMoneyImportLog() below.
 */
export async function readImportLog(
  startCol: string = IMPORT_LOG_START_COL,
  endCol: string = IMPORT_LOG_END_COL
): Promise<ImportLogEntry[]> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${startCol}${IMPORT_LOG_FIRST_DATA_ROW}:${endCol}5000`);
  } catch {
    return [];
  }

  return rows
    .filter((row) => (row[0] ?? '').trim())
    .map((row) => ({
      fileName: (row[0] ?? '').trim(),
      shopCount: parseNumber(row[1]),
      importedAt: (row[2] ?? '').trim(),
      importedBy: (row[3] ?? '').trim(),
    }));
}

export async function readSendMoneyImportLog(): Promise<ImportLogEntry[]> {
  return readImportLog(SENDMONEY_IMPORT_LOG_START_COL, SENDMONEY_IMPORT_LOG_END_COL);
}

async function ensureSheetExists(sheetsApi: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === SHEET_TITLE);
  if (exists) return;

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
    },
  });

  // Reserve Send Money's block with a placeholder label so the tab's shape
  // is visible immediately, even though Cashout ships first and Send
  // Money's own upload isn't wired yet.
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['SEND MONEY (reserved — not yet in use)']] },
  });
}

/**
 * Writes a fresh "assumed balance" upload for Cashout into the "Estimated
 * Opening" tab, replacing whatever was there before (each new upload is a
 * full replacement, not an append — matches "old data stops being used
 * once superseded").
 *
 * The raw wallet-level upload is aggregated per real shop first
 * (extractRealShopName + summed Total DP/Total WD), then combined with the
 * live Opening Balance / Top Up / Settlement (same sources and cutoff-date
 * logic as the existing Company Balance formula in app/agentbal/page.tsx)
 * into one final number per shop:
 *
 *   Assumed Balance = Opening + Uploaded TotalDP + TopUp − Uploaded TotalWD − Settlement
 *
 * Only the final Agent Name / Assumed Balance columns are written for the
 * per-shop table (no intermediate breakdown) — mirrors "Opening AG"'s own
 * Agent Name + balance shape so it's easy to eyeball side-by-side for
 * mismatches. A separate small "WALLET TOTALS" block (own columns, doesn't
 * disturb the shop table) also persists the upload's own Total DP/Total WD
 * grouped by wallet type (Bkash/Nagad/Rocket/Upay) — feeds Balance
 * Overview's Wallet Breakdown Assumed Running Balance. A third, independent
 * block ("IMPORT LOG", its own columns) is overwritten in place per upload
 * (single row, not a growing history) — a shared, cross-device record of who
 * uploaded what and when, since a browser-local record can't prove anything
 * to a different staff member checking from their own device.
 *
 * @param headerRow  The uploaded Excel's own header row (used to locate the
 *                    Account/Bank/Total DP/Total WD columns by name).
 * @param dataRows   The uploaded Excel's raw wallet-level data rows.
 * @param fileName   The uploaded file's own name, for the Import Log.
 */
export async function writeCashoutEstimatedOpening(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  fileName: string
): Promise<{ uploadedAt: string; shopCount: number }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const shopTotals = aggregateByShop(headerRow, dataRows);
  const walletTotals = aggregateByWalletType(headerRow, dataRows);
  const { openingByShop, topUpByShop, stlmByShop } = await fetchLiveShopFigures();

  const assumedBalances = shopTotals.map((s) => {
    const opening = openingByShop.get(s.shopName) ?? 0;
    const topUp = topUpByShop.get(s.shopName) ?? 0;
    const stlm = stlmByShop.get(s.shopName) ?? 0;
    const assumedBalance = opening + s.totalDP + topUp - s.totalWD - stlm;
    return { shopName: s.shopName, assumedBalance };
  });

  const uploadedAt = formatUploadTimestamp(new Date());

  // Clear the shop table and Wallet Totals block only — NOT the Import Log's
  // own columns (H-K), which is meant to persist and grow across uploads.
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${SHEET_TITLE}!${CASHOUT_START_COL}1:C5000`,
  });
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${SHEET_TITLE}!${WALLET_TOTALS_START_COL}1:F5000`,
  });

  const rows: (string | number)[][] = [
    ['CASHOUT — ESTIMATED OPENING'],
    ['Last Updated:', uploadedAt],
    [],
    ['Agent Name', 'Assumed Balance'],
    ...assumedBalances.map((s) => [s.shopName, s.assumedBalance]),
  ];

  const walletTotalsRows: (string | number)[][] = [
    ['WALLET TOTALS (from upload)'],
    [],
    [],
    ['Wallet', 'Uploaded Total DP', 'Uploaded Total WD'],
    ...walletTotals.map((w) => [w.wallet, w.totalDP, w.totalWD]),
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${WALLET_TOTALS_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: walletTotalsRows },
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${CASHOUT_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  await appendImportLogEntry(sheetsApi, spreadsheetId, IMPORT_LOG_START_COL, IMPORT_LOG_END_COL, { fileName, shopCount: shopTotals.length });

  return { uploadedAt, shopCount: shopTotals.length };
}

// Reads the same two live sheets Send Money's own Balance page already reads
// for Company/Running Balance — "Opening AG" cols L-O (Send Money's own
// ~9,983-row roster, separate from Cashout's own A-D) and "PS BD STLM +
// TOPUP" (this reset period's Top Up/Settlement, cutoff-date filtered) — so
// writeSendMoneyEstimatedOpening's Assumed Balance formula can substitute the
// upload's Total DP/Total WD the same way Cashout's does. Unlike Cashout's
// "AG BD STLM + TOPUP", Send Money's own agent names here need no brand-
// suffix stripping (app/sendmoney/balances/page.tsx reads them raw).
//
// The TopUp/Settlement cutoff here is Send Money's own "Opening AG" col I
// "Updated Time" card (e.g. "July 16 - 7:46 AM") — i.e. everything since
// Opening was ACTUALLY last refreshed — NOT getBusinessToday()'s pure
// calendar/2AM-rollover cutoff used elsewhere in the app for the general
// Top Up/Settlement columns (Agent Balance, Balance page, etc., which are
// intentionally calendar-based per that feature's own design). Estimated
// Opening exists specifically to cover the gap between the 2AM rollover and
// Opening's own actual refresh, so it needs everything NOT YET reflected in
// the currently-displayed (stale) Opening — which, once the calendar day
// has already rolled over past the card's own date, is more than just
// "today": using getBusinessToday() here silently dropped a shop's own
// prior-day Settlement/TopUp that posted AFTER Opening's last refresh but
// BEFORE the next rollover — confirmed against a real shop on 2026-07-17
// (D-M1BD-ECHO029-NG: a same-day −109,940 Settlement wasn't deducted,
// making the Estimated figure exactly 109,940 too high).
async function fetchLiveSendMoneyShopFigures(): Promise<LiveShopFigures> {
  const [openingRows, updatedTimeRows, stlmRows] = await Promise.all([
    fetchRange('Opening AG!L:O'),
    fetchRange('Opening AG!I1:I10'),
    fetchRange('PS BD STLM + TOPUP'),
  ]);

  const openingByShop = new Map<string, number>();
  openingRows.slice(1).forEach((row) => {
    const agentName = (row[0] ?? '').trim();
    if (!agentName || agentName === '-' || agentName === 'OLD') return;
    openingByShop.set(agentName.toUpperCase(), parseNumber(row[1]));
  });

  let reportCutoffDate: Date | null = null;
  for (const row of updatedTimeRows) {
    reportCutoffDate = parseCardCutoffDate(row[0] ?? '');
    if (reportCutoffDate) break;
  }
  // Falls back to the calendar cutoff only if the card itself can't be
  // parsed (missing/malformed) — better to under- than over-include.
  if (!reportCutoffDate) reportCutoffDate = getBusinessToday();

  const topUpByShop = new Map<string, number>();
  const stlmByShop = new Map<string, number>();
  stlmRows.slice(1).forEach((row) => {
    // Top Up cols B-F (idx 1-5): idx1=agent, idx2=amount, idx3=date.
    const topUpAgent = (row[1] ?? '').trim().toUpperCase();
    const topUpAmount = (row[2] ?? '').trim();
    const topUpDate = reportCutoffDate ? parseStlmRowDate((row[3] ?? '').trim()) : null;
    if (
      topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
      (!reportCutoffDate || (topUpDate && topUpDate >= reportCutoffDate))
    ) {
      const amount = Math.abs(parseNumber(topUpAmount));
      topUpByShop.set(topUpAgent, (topUpByShop.get(topUpAgent) ?? 0) + amount);
    }

    // Settlement cols H-L (idx 7-11): idx7=agent, idx8=amount (stored
    // negative — abs()'d before use), idx9=date.
    const stlmAgent = (row[7] ?? '').trim().toUpperCase();
    const stlmAmount = (row[8] ?? '').trim();
    const stlmDate = reportCutoffDate ? parseStlmRowDate((row[9] ?? '').trim()) : null;
    if (
      stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
      (!reportCutoffDate || (stlmDate && stlmDate >= reportCutoffDate))
    ) {
      const amount = Math.abs(parseNumber(stlmAmount));
      stlmByShop.set(stlmAgent, (stlmByShop.get(stlmAgent) ?? 0) + amount);
    }
  });

  return { openingByShop, topUpByShop, stlmByShop };
}

/**
 * Send Money's own counterpart to writeCashoutEstimatedOpening — same upload
 * shape (Account/Bank/Total DP/Total WD columns), same three-block layout
 * (shop table / Wallet Totals / Import Log), written into the SAME
 * "Estimated Opening" tab Cashout already uses (no new sheet), just shifted
 * into Send Money's reserved column block (M onward — see
 * SENDMONEY_START_COL and the other SENDMONEY_* column constants above).
 *
 * Deliberately does NOT bake TopUp/Settlement into the stored per-shop
 * value (unlike Cashout's own writeCashoutEstimatedOpening, still untouched)
 * — only `Opening + uploaded Total DP − uploaded Total WD` is persisted.
 * TopUp/Settlement are added fresh at READ time instead (see
 * readSendMoneyEstimatedOpening), for every shop uniformly, not just the
 * ones missing from this upload. Freezing them here previously caused the
 * Estimated total to silently drift away from the real (live) Ending
 * Balance the longer a single upload stayed in use — a same-day Settlement
 * posted after the upload was never reflected — confirmed against real
 * numbers on 2026-07-17 (uploaded shops were short by exactly the
 * post-upload Settlement growth for those same shops).
 */
export async function writeSendMoneyEstimatedOpening(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  fileName: string
): Promise<{ uploadedAt: string; shopCount: number }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const shopTotals = aggregateByShop(headerRow, dataRows, extractSendMoneyShopName);
  const walletTotals = aggregateByWalletType(headerRow, dataRows);
  const { openingByShop } = await fetchLiveSendMoneyShopFigures();

  const assumedBalances = shopTotals.map((s) => {
    const opening = openingByShop.get(s.shopName) ?? 0;
    const assumedBalance = opening + s.totalDP - s.totalWD;
    return { shopName: s.shopName, assumedBalance };
  });

  const uploadedAt = formatUploadTimestamp(new Date());

  // Clear the shop table and Wallet Totals block only — NOT the Import Log's
  // own columns (T-W), same rule as Cashout's own clear below.
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_START_COL}1:O5000`,
  });
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_WALLET_TOTALS_START_COL}1:R5000`,
  });

  const rows: (string | number)[][] = [
    ['SEND MONEY — ESTIMATED OPENING'],
    ['Last Updated:', uploadedAt],
    [],
    ['Agent Name', 'Assumed Balance'],
    ...assumedBalances.map((s) => [s.shopName, s.assumedBalance]),
  ];

  const walletTotalsRows: (string | number)[][] = [
    ['WALLET TOTALS (from upload)'],
    [],
    [],
    ['Wallet', 'Uploaded Total DP', 'Uploaded Total WD'],
    ...walletTotals.map((w) => [w.wallet, w.totalDP, w.totalWD]),
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_WALLET_TOTALS_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: walletTotalsRows },
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  await appendImportLogEntry(sheetsApi, spreadsheetId, SENDMONEY_IMPORT_LOG_START_COL, SENDMONEY_IMPORT_LOG_END_COL, { fileName, shopCount: shopTotals.length });

  return { uploadedAt, shopCount: shopTotals.length };
}

// Inverse of formatUploadTimestamp: "MM/DD/YYYY HH:MM AM/PM" (Manila wall
// clock, see formatUploadTimestamp above) -> the true absolute instant.
function parseUploadTimestamp(str: string): Date | null {
  const match = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min, ampm] = match;
  let hours = parseInt(hh, 10);
  if (/PM/i.test(ampm) && hours !== 12) hours += 12;
  if (/AM/i.test(ampm) && hours === 12) hours = 0;
  const manilaWallClockMs = Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hours, parseInt(min, 10));
  return fromManilaWallClockMs(manilaWallClockMs);
}

export type EstimatedOpeningWalletTotals = { totalDP: number; totalWD: number };

/**
 * Reads the Cashout block of "Estimated Opening" back out — one Assumed
 * Balance per shop, the wallet-type (Bkash/Nagad/Rocket/Upay) Total DP/Total
 * WD breakdown, plus the upload's own "Last Updated" timestamp (parsed).
 * Read-only (uses the existing read-only client via fetchRange, not this
 * file's write-scoped one). Returns empty maps + null timestamp if the
 * sheet/tab doesn't exist yet (nothing uploaded).
 */
export async function readCashoutEstimatedOpening(): Promise<{
  balances: Map<string, number>;
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
}> {
  let rows: string[][];
  let walletRows: string[][];
  try {
    [rows, walletRows] = await Promise.all([
      fetchRange(`${SHEET_TITLE}!${CASHOUT_START_COL}1:B5000`),
      fetchRange(`${SHEET_TITLE}!${WALLET_TOTALS_START_COL}1:F10`),
    ]);
  } catch {
    return { balances: new Map(), walletTotals: new Map(), uploadedAt: null };
  }

  // Layout (see writeCashoutEstimatedOpening): title row, "Last Updated:"
  // row, blank row, header row, then one [Agent Name, Assumed Balance] row
  // per shop.
  const uploadedAt = parseUploadTimestamp(rows[1]?.[1] ?? '');

  const balances = new Map<string, number>();
  rows.slice(4).forEach((row) => {
    const shopName = (row[0] ?? '').trim();
    if (!shopName) return;
    balances.set(shopName, parseNumber(row[1]));
  });

  // Wallet totals block layout (own columns, see writeCashoutEstimatedOpening):
  // title row, blank, blank, header row, then one [Wallet, TotalDP, TotalWD] row.
  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  walletRows.slice(4).forEach((row) => {
    const wallet = (row[0] ?? '').trim().toUpperCase();
    if (!wallet) return;
    walletTotals.set(wallet, { totalDP: parseNumber(row[1]), totalWD: parseNumber(row[2]) });
  });

  return { balances, walletTotals, uploadedAt };
}

/**
 * Send Money's own counterpart to readCashoutEstimatedOpening — same shape,
 * reads from Send Money's own reserved column block (M onward) in the same
 * "Estimated Opening" tab instead of Cashout's (A onward).
 *
 * Also returns `balancesWithFallback`: for EVERY shop in the live roster
 * ("Opening AG" cols L-O) — not just the ones missing from this upload —
 * TopUp/Settlement (live, cutoff-filtered) are added fresh here at read
 * time, on top of either that shop's uploaded base (`Opening + uploaded
 * Total DP − uploaded Total WD`, from `balances`) or its live Opening alone
 * if the shop wasn't in the upload. TopUp/Settlement are intentionally
 * NEVER frozen at upload time (see writeSendMoneyEstimatedOpening) — a
 * single upload may stay in use for hours, and same-day Settlement/TopUp
 * keeps posting after it; recomputing fresh on every read is the only way
 * the total keeps matching the real (live) Ending Balance instead of
 * drifting further off the longer the upload has been in use. `balances`
 * itself (uploaded-only, no TopUp/Settlement) is left unchanged for
 * existing per-shop consumers (e.g. app/sendmoney/balances/page.tsx) that
 * add their own live TopUp/Settlement independently.
 */
export async function readSendMoneyEstimatedOpening(): Promise<{
  balances: Map<string, number>;
  balancesWithFallback: Map<string, number>;
  walletTotals: Map<string, EstimatedOpeningWalletTotals>;
  uploadedAt: Date | null;
}> {
  let rows: string[][];
  let walletRows: string[][];
  try {
    [rows, walletRows] = await Promise.all([
      fetchRange(`${SHEET_TITLE}!${SENDMONEY_START_COL}1:N5000`),
      fetchRange(`${SHEET_TITLE}!${SENDMONEY_WALLET_TOTALS_START_COL}1:R10`),
    ]);
  } catch {
    return { balances: new Map(), balancesWithFallback: new Map(), walletTotals: new Map(), uploadedAt: null };
  }

  // Same layout as Cashout's own block (see writeSendMoneyEstimatedOpening).
  const uploadedAt = parseUploadTimestamp(rows[1]?.[1] ?? '');

  const balances = new Map<string, number>();
  rows.slice(4).forEach((row) => {
    const shopName = (row[0] ?? '').trim();
    if (!shopName) return;
    balances.set(shopName, parseNumber(row[1]));
  });

  const walletTotals = new Map<string, EstimatedOpeningWalletTotals>();
  walletRows.slice(4).forEach((row) => {
    const wallet = (row[0] ?? '').trim().toUpperCase();
    if (!wallet) return;
    walletTotals.set(wallet, { totalDP: parseNumber(row[1]), totalWD: parseNumber(row[2]) });
  });

  const balancesWithFallback = new Map<string, number>();
  const { openingByShop, topUpByShop, stlmByShop } = await fetchLiveSendMoneyShopFigures();
  openingByShop.forEach((opening, shopName) => {
    const uploadedBase = balances.get(shopName);
    const topUp = topUpByShop.get(shopName) ?? 0;
    const stlm = stlmByShop.get(shopName) ?? 0;
    const base = uploadedBase ?? opening;
    balancesWithFallback.set(shopName, base + topUp - stlm);
  });

  return { balances, balancesWithFallback, walletTotals, uploadedAt };
}
