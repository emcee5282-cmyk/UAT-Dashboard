// Estimated Balance — transaction-based upload (2026-11-16). Replaces the
// old pre-summed Balance Limit file (Account/Bank/Total DP/Total WD per
// wallet) with the payment system's own raw transaction exports, which the
// dashboard now adds up itself:
//   - DP = "Export Deposit ..." (QR Transaction History): shop wallet is in
//     "To Account" (money lands in the shop's wallet).
//   - WD = "Export Payout ..." (Payout History): shop wallet is in
//     "From Account" (money leaves the shop's wallet).
// The user picks DP or WD before uploading; a file of the other kind is
// rejected. Every row with Status "Successful" counts, regardless of Audit.
// Sums are kept per raw Account text (= per wallet, e.g. "<phone> - D-M1AG-
// L1-KJ008-BK") and per day of "Updated Time", so the server can keep only
// the day the upload counts for (see importEstimatedTransactionsUpload).
//
// Pure, no I/O — shared by the upload modal's preview and the server.
import { isValidNumericCell } from './uploadValidation';
import { CASHOUT_IGNORED_WALLET_TYPES, type EstimateRowError } from './estimateUpload';
import { resolveOldAccount } from './balanceLimitParser';
import { extractOpeningWalletTypeSuffix } from './realShopName';
import { OPENING_SUFFIX_TO_WALLET_TYPE, WALLET_TYPE_TO_OPENING_SUFFIX } from './shopDisplayName';

export type EstimateKind = 'dp' | 'wd';

export const ESTIMATE_KIND_LABEL: Record<EstimateKind, string> = { dp: 'Deposit (DP)', wd: 'Withdrawal (WD)' };

// Which column holds the shop's own wallet for each kind.
export const ESTIMATE_KIND_ACCOUNT_COLUMN: Record<EstimateKind, string> = { dp: 'To Account', wd: 'From Account' };

// One wallet's sum for one day — what the browser sends and the server stores.
export type EstimateWalletSum = { account: string; bank: string; date: string; amount: number; count: number };

function norm(h: unknown): string {
  return String(h ?? '').trim().toLowerCase();
}

function col(headerRow: (string | number)[], label: string): number {
  return headerRow.findIndex((h) => norm(h) === label.toLowerCase());
}

// The Deposit export has a "Deposit Type" column; the Payout export has
// "Type" + "SPID" instead. null = neither (e.g. an old Balance Limit file).
export function detectExportKind(headerRow: (string | number)[]): EstimateKind | null {
  const has = (label: string) => col(headerRow, label) !== -1;
  if (!has('From Account') || !has('To Account') || !has('Amount')) return null;
  if (has('Deposit Type')) return 'dp';
  if (has('SPID') || has('Type')) return 'wd';
  return null;
}

// "Updated Time" -> 'YYYY-MM-DD', as written in the file (the export's own
// GMT+6 clock, whose midnight is the same instant as the Manila 2 AM
// business-day rollover — so the file's calendar date IS the business day).
// Accepts the export's text form "16/11/2026 11:24:26" and an Excel date
// serial number, in case the cell was saved as a real date.
export function parseUpdatedDate(cell: unknown): string | null {
  if (typeof cell === 'number' && Number.isFinite(cell) && cell > 20000) {
    const ms = Math.round((cell - 25569) * 86400 * 1000); // Excel serial -> Unix ms, read as wall clock
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(String(cell ?? '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' -> the day before. An upload made on business day D counts
// for D-1 (same rule the server applies, kept here for the preview only).
export function previousDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d - 1));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' -> "Nov 15, 2026".
export function formatEstimateDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function parseAmount(cell: unknown): number {
  if (typeof cell === 'number') return cell;
  const cleaned = String(cell ?? '').replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// The shops the import can add to (agent_code → its Opening wallet lines as
// full wallet types, null = no lines so every wallet counts) and the day the
// upload counts for. Served by GET upload-estimated-balance
// (getEstimateShopWallets) — the exact set the server matches against.
export type EstimateShopCheck = { activityDate: string; shops: Readonly<Record<string, string[] | null>> };

// Why a transaction for the counted day would be left out by the import,
// or null when it will be added. Mirrors the server step by step:
// resolveRowShop (MANUAL skipped, OLD re-resolved to its real shop), then
// agentByCode (shop must exist), then — for a shop Opening splits into wallet
// lines — the row's wallet suffix must match one of those lines.
export function unaddableReason(
  rawAccount: string,
  extractShopName: (raw: string | number) => string,
  shops: EstimateShopCheck['shops']
): string | null {
  let shopCode = extractShopName(rawAccount);
  let account = rawAccount;
  if (shopCode === 'MANUAL') return 'MANUAL account, not a shop — won\'t be added';
  if (shopCode === 'OLD') {
    const real = resolveOldAccount(rawAccount, extractShopName);
    if (!real) return 'OLD account that can\'t be matched to a shop — won\'t be added';
    shopCode = real.shopCode;
    account = real.account;
  }
  if (!Object.prototype.hasOwnProperty.call(shops, shopCode)) return `Shop ${shopCode} not found — won't be added`;
  const lines = shops[shopCode];
  if (lines === null) return null;
  const suffix = extractOpeningWalletTypeSuffix(account);
  const walletType = suffix ? OPENING_SUFFIX_TO_WALLET_TYPE[suffix] : undefined;
  if (walletType && lines.includes(walletType)) return null;
  const known = lines.map((w) => WALLET_TYPE_TO_OPENING_SUFFIX[w] ?? w).join('/') || 'none';
  return `Wallet ${suffix ? `-${suffix}` : '(unknown)'} isn't one of ${shopCode}'s Opening wallets (${known}) — won't be added`;
}

export type ParsedEstimateTransactions = {
  // Successful rows considered (the rows Errors/Skip are counted against).
  txnCount: number;
  detectedErrors: number;
  rowErrors: EstimateRowError[];
  // Distinct shops among Successful, error-free rows.
  shopCount: number;
  // Rows left out on purpose — not Successful, or an ignored wallet type.
  notSuccessfulCount: number;
  // Successful, error-free rows per Updated Time day.
  countByDate: Record<string, number>;
  // The per-wallet, per-day sums (skippedRows and error rows left out).
  sums: EstimateWalletSum[];
};

// Throws on a wrong/unknown file so the preview can stop at the upload
// step with a clear message. allowedWalletTypes is Cashout's own guard
// (same set the server checks); Send Money passes undefined.
export function parseEstimateTransactions(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  kind: EstimateKind,
  extractShopName: (raw: string | number) => string,
  allowedWalletTypes?: ReadonlySet<string>,
  skippedRows: ReadonlySet<number> = new Set(),
  shopCheck?: EstimateShopCheck
): ParsedEstimateTransactions {
  const fileKind = detectExportKind(headerRow);
  if (!fileKind) {
    throw new Error('This doesn\'t look like a Deposit or Payout export — expected columns like "From Account", "To Account", "Amount" and "Updated Time".');
  }
  if (fileKind !== kind) {
    throw new Error(
      fileKind === 'dp'
        ? 'This is a Deposit export, but Withdrawal (WD) was selected. Choose Deposit (DP) or upload the Payout export.'
        : 'This is a Payout export, but Deposit (DP) was selected. Choose Withdrawal (WD) or upload the Deposit export.'
    );
  }
  const accountLabel = ESTIMATE_KIND_ACCOUNT_COLUMN[kind];
  const accountCol = col(headerRow, accountLabel);
  const amountCol = col(headerRow, 'Amount');
  const bankCol = col(headerRow, 'Bank');
  const statusCol = col(headerRow, 'Status');
  const updatedCol = col(headerRow, 'Updated Time');
  const missing = [
    [accountCol, accountLabel], [amountCol, 'Amount'], [bankCol, 'Bank'], [statusCol, 'Status'], [updatedCol, 'Updated Time'],
  ].filter(([i]) => i === -1).map(([, label]) => label);
  if (missing.length > 0) throw new Error(`The file is missing column(s): ${missing.join(', ')}.`);

  const rowErrors: EstimateRowError[] = [];
  const errorRows = new Set<number>();
  const shops = new Set<string>();
  const countByDate: Record<string, number> = {};
  const sumsByKey = new Map<string, EstimateWalletSum>();
  let txnCount = 0;
  let notSuccessfulCount = 0;

  dataRows.forEach((row, i) => {
    const rowNumber = i + 2; // spreadsheet row (1-based + header)
    if (norm(row[statusCol]) !== 'successful') { notSuccessfulCount++; return; }
    const bank = String(row[bankCol] ?? '').trim().toUpperCase();
    if (allowedWalletTypes && CASHOUT_IGNORED_WALLET_TYPES.has(bank)) { notSuccessfulCount++; return; }
    txnCount++;

    const rawAccount = String(row[accountCol] ?? '').trim();
    const shopCode = rawAccount || '(blank)';
    const shopName = extractShopName(rawAccount);
    const flag = (column: string, value: unknown, message: string) => {
      errorRows.add(rowNumber);
      rowErrors.push({ row: rowNumber, shopCode, shopName: shopName || '—', column, value: String(value ?? ''), message });
    };
    if (!shopName) flag(accountLabel, rawAccount, 'Missing or invalid shop code');
    if (allowedWalletTypes && !allowedWalletTypes.has(bank)) flag('Bank', row[bankCol], 'Unknown wallet type');
    if (!isValidNumericCell(row[amountCol]) || String(row[amountCol] ?? '').trim() === '') flag('Amount', row[amountCol], 'Invalid number format');
    const date = parseUpdatedDate(row[updatedCol]);
    if (!date) flag('Updated Time', row[updatedCol], 'Invalid date (expected DD/MM/YYYY)');
    // Only the counted day — other days' rows are ignored anyway, so a
    // can't-be-added flag on them would just be noise.
    if (shopCheck && date === shopCheck.activityDate && !errorRows.has(rowNumber)) {
      const reason = unaddableReason(rawAccount, extractShopName, shopCheck.shops);
      if (reason) flag(accountLabel, rawAccount, reason);
    }
    if (errorRows.has(rowNumber) || skippedRows.has(rowNumber) || !date) return;

    shops.add(shopName);
    countByDate[date] = (countByDate[date] ?? 0) + 1;
    const key = `${rawAccount}\u0000${bank}\u0000${date}`;
    const sum = sumsByKey.get(key) ?? { account: rawAccount, bank, date, amount: 0, count: 0 };
    sum.amount += parseAmount(row[amountCol]);
    sum.count += 1;
    sumsByKey.set(key, sum);
  });

  // Round to cents — summing thousands of 2-decimal floats drifts.
  const sums = Array.from(sumsByKey.values()).map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }));
  return { txnCount, detectedErrors: errorRows.size, rowErrors, shopCount: shops.size, notSuccessfulCount, countByDate, sums };
}
