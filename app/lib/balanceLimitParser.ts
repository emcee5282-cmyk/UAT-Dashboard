// Balance Limit's own column contract — a raw wallet-level export matching
// the real Payment file's own header names exactly (confirmed live: Bank,
// Channel, Group, Account, Balance, Balance Limit, DP Limit, Total DP,
// Remaining DP, WD Limit, Total WD, Remaining WD, Update Time, Login,
// Status), so the natural "download the current export, upload it back"
// flow needs no reformatting.
//
// "Account Status" is NEVER a real input column — the raw file has no such
// column (previously required one that doesn't exist, breaking every real
// upload — fixed). It's a derived value: Group -> Actual Status lookup,
// combined with the Login="No" -> Disconnected override (see
// app/lib/balanceEngine.ts's normalizeWalletStatus/computeWalletStatus),
// computed downstream by every consumer, not read here. `accountStatus` on
// BalanceLimitRow below is populated straight from the raw Group text for
// exactly that reason — same string, kept as its own field since every
// existing downstream caller already reads `accountStatus` as "the text to
// feed normalizeWalletStatus" independently of `group` (used separately for
// brand resolution).
//
// Shop identity is deliberately NEVER trusted from a pre-resolved "Wallet
// Name"-style column even when one happens to be present in the uploaded
// file — per explicit instruction, every row's shop is resolved from the
// raw "Account" cell (e.g. "01818938877 - D-M1AG-M1-JETT003-BK") through
// the exact same extractRealShopName/extractSendMoneyShopName formulas
// Estimated Opening's own upload already uses (app/lib/realShopName.ts),
// not reimplemented here.
import { type ParsedWorkbook } from './xlsxParser';
import { extractRealShopName, extractSendMoneyShopName } from './realShopName';

export type Product = 'cashout' | 'sendmoney';

export type BalanceLimitRow = {
  row: number; // 1-based, matching the row's real spreadsheet position
  rawAccount: string;
  shopCode: string; // '' if unresolvable — same convention as realShopName.ts's own functions
  accountStatus: string;
  bank: string; // raw wallet-type text, e.g. "BKASH" / "NAGADC"
  group: string;
  balance: string;
  totalDP: string;
  totalWD: string;
  login: string;
};

function findHeaderRowIndex(allRows: (string | number)[][]): number {
  return allRows.findIndex((row) =>
    row.some((cell) => String(cell ?? '').trim().toLowerCase() === 'account')
  );
}

function colIndex(normalizedHeader: string[], ...names: string[]): number {
  for (const name of names) {
    const found = normalizedHeader.indexOf(name);
    if (found !== -1) return found;
  }
  return -1;
}

export function mapBalanceLimitRows(parsed: ParsedWorkbook, product: Product): BalanceLimitRow[] {
  const headerRowIndex = findHeaderRowIndex(parsed.allRows);
  if (headerRowIndex === -1) {
    throw new Error('Could not find an "Account" column — this doesn\'t look like a Balance Limit export.');
  }
  const headerRow = parsed.allRows[headerRowIndex];
  const dataRows = parsed.allRows.slice(headerRowIndex + 1);
  const normalizedHeader = headerRow.map((h) => String(h ?? '').trim().toLowerCase());

  // "Account Status" is deliberately absent here — it's never a real input
  // column (see this file's header comment), so it's never checked or
  // looked up as one.
  const indices = {
    account: colIndex(normalizedHeader, 'account'),
    bank: colIndex(normalizedHeader, 'bank'),
    group: colIndex(normalizedHeader, 'group'),
    balance: colIndex(normalizedHeader, 'balance'),
    totalDP: colIndex(normalizedHeader, 'total dp'),
    totalWD: colIndex(normalizedHeader, 'total wd'),
    login: colIndex(normalizedHeader, 'login'),
  };
  const COLUMN_LABELS: Record<keyof typeof indices, string> = {
    account: 'Account',
    bank: 'Bank',
    group: 'Group',
    balance: 'Balance',
    totalDP: 'Total DP',
    totalWD: 'Total WD',
    login: 'Login',
  };
  const missing = Object.entries(indices).filter(([, idx]) => idx === -1).map(([key]) => COLUMN_LABELS[key as keyof typeof indices]);
  if (missing.length > 0) {
    throw new Error(`Uploaded file is missing required column(s): ${missing.join(', ')}.`);
  }

  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;

  return dataRows
    .filter((cols) => cols.some((cell) => String(cell ?? '').trim() !== ''))
    .map((cols, i) => {
      const rawAccount = String(cols[indices.account] ?? '').trim();
      const group = String(cols[indices.group] ?? '').trim();
      return {
        row: headerRowIndex + i + 2,
        rawAccount,
        shopCode: extractShopName(rawAccount),
        // Derived from Group, not a real input column — see this file's own
        // header comment. Fed into normalizeWalletStatus downstream exactly
        // like every other Group-sourced status text in this app.
        accountStatus: group,
        bank: String(cols[indices.bank] ?? '').trim(),
        group,
        balance: String(cols[indices.balance] ?? '').trim(),
        totalDP: String(cols[indices.totalDP] ?? '').trim(),
        totalWD: String(cols[indices.totalWD] ?? '').trim(),
        login: String(cols[indices.login] ?? '').trim(),
      };
    });
}
