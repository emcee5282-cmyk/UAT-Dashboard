// Balance Limit's own column contract — a raw wallet-level export matching
// the real Payment file's own header names exactly (confirmed 2026-08-19
// against a real downloaded export, BalanceLimit-2026-08-19.xlsx): Bank,
// Channel, Group, Account, Balance, Balance Limit, DP Limit, Total DP,
// Remaining DP, WD Limit, Total WD, Remaining WD, Update Time, Login,
// Status — Status is the LAST column, so the natural "download the current
// export, upload it back" flow needs no reformatting.
//
// CORRECTED 2026-08-19 — the real per-wallet Reach Limit status ("Monthly
// Reach Limit", "Daily Reach Limit") lives in this file's own "Status"
// column, confirmed directly against the real export above. Two earlier,
// wrong assumptions both traced back to confusing this file with a
// DIFFERENT data feed (the live "SSP PS BalanceLimit" Google Sheet, which
// has its own separate "Account Status" and "Status" columns neither of
// which this manual export actually carries):
//   1. "Account Status is never a real input column" — so accountStatus was
//      derived from Group instead, silently discarding whatever this file's
//      real status data was.
//   2. Assuming the real column was named "Account Status" — it isn't; this
//      file's own status column is literally named "Status".
//
// CORRECTED AGAIN 2026-08-19 — reading accountStatus purely from Status
// (dropping Group entirely) was ALSO wrong, confirmed against a real
// cross-tab of the full uploaded dataset: Status's own vocabulary is only
// ever "Active" / "Disable" / "Daily Reach Limit" / "Monthly Reach Limit" —
// it NEVER contains the DP+WD/WD Only/DP Only composition text
// normalizeWalletStatus (balanceEngine.ts) actually needs to classify a
// wallet; that composition text lives ONLY in Group ("SH- Day Solo WD
// Only" etc.). Status="Active" on ~6,300 real rows was silently defaulting
// every one of them to "Disconnected" because "active" matches none of
// normalizeWalletStatus's own substring checks. Fixed: accountStatus is
// Status's own text ONLY when it's Reach Limit or Disable (real, distinct
// signals Group can never carry — both now real cases in
// normalizeWalletStatus, per explicit instruction, for both products);
// every other case (Active, blank) falls back to Group, exactly restoring
// the original composition-detection behavior this file always had. This
// is a narrow, deliberate combination — not the original "Group silently
// overwrites real Status data" bug all over again, since Status's own
// distinctive information (Reach Limit/Disable) is never the one being
// discarded.
//
// "Status" is kept OPTIONAL, not required — a real upload already broke
// once from a required-column check on the wrong name; a file missing this
// column (some older export variant, say) should still import, falling
// back to Group for every row exactly as if Status were always blank.
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
  // The file's own real per-wallet Daily Limit — Wallet Status's
  // dailyLimit now reads this directly (no more staff override/flat
  // default), per explicit instruction that Daily Limit isn't editable
  // and must always be exactly what the file says.
  dpLimit: string;
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

  // Required — same columns this file has always required, plus DP Limit
  // (added so Daily Limit can be sourced directly from the file — see
  // BalanceLimitRow's own comment).
  const indices = {
    account: colIndex(normalizedHeader, 'account'),
    bank: colIndex(normalizedHeader, 'bank'),
    group: colIndex(normalizedHeader, 'group'),
    balance: colIndex(normalizedHeader, 'balance'),
    totalDP: colIndex(normalizedHeader, 'total dp'),
    totalWD: colIndex(normalizedHeader, 'total wd'),
    login: colIndex(normalizedHeader, 'login'),
    dpLimit: colIndex(normalizedHeader, 'dp limit'),
  };
  const COLUMN_LABELS: Record<keyof typeof indices, string> = {
    account: 'Account',
    bank: 'Bank',
    group: 'Group',
    balance: 'Balance',
    totalDP: 'Total DP',
    totalWD: 'Total WD',
    login: 'Login',
    dpLimit: 'DP Limit',
  };
  const missing = Object.entries(indices).filter(([, idx]) => idx === -1).map(([key]) => COLUMN_LABELS[key as keyof typeof indices]);
  if (missing.length > 0) {
    throw new Error(`Uploaded file is missing required column(s): ${missing.join(', ')}.`);
  }

  // Optional — see this file's own header comment. Present -> read as its
  // own field. Absent entirely -> every row's accountStatus is just ''.
  const statusIndex = colIndex(normalizedHeader, 'status');

  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;

  // General rule (not a per-brand special case): a shop with real DP/WD
  // activity must never be silently dropped just because its raw Account
  // text doesn't match any recognized extraction pattern (unknown brand,
  // unusual format, etc.) — falls back to the raw text itself (minus a
  // leading "<phone> - " prefix, the one part that's never itself the shop
  // identity) instead of leaving shopCode blank, which validateRow would
  // otherwise hard-reject the row for. This mirrors what already happens
  // naturally for a recognized-brand raw account string (Pattern3's own
  // "AG-" fallback already returns the raw text when the brand isn't on
  // the known list) — this just guarantees the SAME safety net for the
  // narrower case where extraction produces nothing at all.
  const fallbackRawShopCode = (rawAccount: string): string => {
    const idx = rawAccount.indexOf(' - ');
    const withoutPhonePrefix = idx === -1 ? rawAccount : rawAccount.slice(idx + 3);
    return withoutPhonePrefix.trim().toUpperCase();
  };

  return dataRows
    .filter((cols) => cols.some((cell) => String(cell ?? '').trim() !== ''))
    .map((cols, i) => {
      const rawAccount = String(cols[indices.account] ?? '').trim();
      const group = String(cols[indices.group] ?? '').trim();
      const statusText = statusIndex === -1 ? '' : String(cols[statusIndex] ?? '').trim();
      return {
        row: headerRowIndex + i + 2,
        rawAccount,
        shopCode: extractShopName(rawAccount) || fallbackRawShopCode(rawAccount),
        // Status wins ONLY for its distinctive pieces of real information
        // (Reach Limit, Disable) — see this file's own header comment.
        // Every other case (Active, blank Status column) falls back to
        // Group, which is the only field that actually carries the
        // DP+WD/WD Only/DP Only composition normalizeWalletStatus needs.
        accountStatus: /reach limit/i.test(statusText) || /disable/i.test(statusText) ? statusText : group,
        bank: String(cols[indices.bank] ?? '').trim(),
        group,
        balance: String(cols[indices.balance] ?? '').trim(),
        totalDP: String(cols[indices.totalDP] ?? '').trim(),
        totalWD: String(cols[indices.totalWD] ?? '').trim(),
        login: String(cols[indices.login] ?? '').trim(),
        dpLimit: String(cols[indices.dpLimit] ?? '').trim(),
      };
    });
}
