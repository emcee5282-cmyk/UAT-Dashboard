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
  // The file's own "Status" cell as-is ("Active"/"Locked"/...), '' when the
  // column is absent — accountStatus above only keeps it for Reach Limit/
  // Disable, so mergeSendMoneyLockedRows needs the untouched text.
  rawStatus: string;
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
        rawStatus: statusText,
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

// Send Money only — the same shop + wallet sometimes appears twice in one
// file under different leader/brand prefixes, e.g. "N-B2PS3-SHEL042-NG"
// (Status Locked, the old name) and "N-M1PS3-SHEL042-NG" (Status Active).
// Per explicit instruction they are ONE shop: the Locked row's Total DP/
// Total WD are added onto the Active row and the Locked row is dropped;
// everything else (name, group, status, login, balance, DP limit) follows
// the Active row only — the Locked row's Balance is NOT carried over. Only
// Status "Locked" merges (Disable/Reach Limit rows stay separate), and only
// when the group has exactly one Active row to merge into; anything
// ambiguous (no Active, 2+ Active) is left untouched. A row whose DP/WD
// isn't a valid number is never merged, so validateRow still reports it.
function lockedMergeKey(row: BalanceLimitRow): string | null {
  // Whitespace stripped — real files also carry "N- M2PS1-BROOK058-NG".
  const parts = row.shopCode.replace(/\s+/g, '').toUpperCase().split('-');
  if (parts.length < 4) return null;
  return `${parts[0]}|${parts.slice(2).join('-')}|${row.bank.trim().toUpperCase()}`;
}

function parseAmount(val: string): number {
  const cleaned = val.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function isValidAmount(val: string): boolean {
  const cleaned = val.replace(/,/g, '').trim();
  return !cleaned || cleaned === '-' || Number.isFinite(Number(cleaned));
}

export function mergeSendMoneyLockedRows(rows: BalanceLimitRow[]): BalanceLimitRow[] {
  const groups = new Map<string, BalanceLimitRow[]>();
  for (const row of rows) {
    const key = lockedMergeKey(row);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }

  const dropped = new Set<BalanceLimitRow>();
  const replaced = new Map<BalanceLimitRow, BalanceLimitRow>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const active = group.filter((r) => /^active$/i.test(r.rawStatus));
    if (active.length !== 1) continue;
    const target = active[0];
    if (!isValidAmount(target.totalDP) || !isValidAmount(target.totalWD)) continue;
    const locked = group.filter((r) =>
      r !== target &&
      /^locked$/i.test(r.rawStatus) &&
      r.shopCode !== target.shopCode && // only the different-prefix case
      isValidAmount(r.totalDP) && isValidAmount(r.totalWD)
    );
    if (locked.length === 0) continue;
    const totalDP = locked.reduce((s, r) => s + parseAmount(r.totalDP), parseAmount(target.totalDP));
    const totalWD = locked.reduce((s, r) => s + parseAmount(r.totalWD), parseAmount(target.totalWD));
    replaced.set(target, { ...target, totalDP: String(totalDP), totalWD: String(totalWD) });
    for (const r of locked) dropped.add(r);
  }

  return rows.filter((r) => !dropped.has(r)).map((r) => replaced.get(r) ?? r);
}

// Both products — an "OLD" account (e.g. "N-M1PS2-DREAM001A-NG-OLD",
// "...-JETT020-BKOLD") used to be dropped outright, losing its Total DP/
// Total WD. Per explicit instruction its DP/WD now counts toward the real
// shop: the OLD tag is stripped, the account is re-resolved to its shop, and
// its DP/WD is added onto that shop's current same-wallet row (Active first,
// else the first one; Send Money also matches a prefix-changed name the same
// way mergeSendMoneyLockedRows does). With no current row to merge into it
// is kept as its own wallet line under the real shop, Balance 0. Its Balance
// is never carried over. OLD rows with no DP/WD, an unparseable amount, or a
// name that can't be resolved stay dropped exactly as before.
const OLD_TAG_AT_END = /[\s-]*\(?OLD\)?\s*$/i;
const OLD_TAG_AT_START = /^\(?OLD\)?[\s-]+/i;

export function stripOldTag(rawAccount: string): string | null {
  const idx = rawAccount.indexOf(' - ');
  const phonePrefix = idx === -1 ? '' : rawAccount.slice(0, idx + 3);
  const name = (idx === -1 ? rawAccount : rawAccount.slice(idx + 3)).trim();
  const stripped = name.replace(OLD_TAG_AT_END, '').replace(OLD_TAG_AT_START, '').trim();
  if (stripped === name || !stripped || /OLD/i.test(stripped)) return null;
  return phonePrefix + stripped;
}

// An OLD account → its real shop: tag stripped, name re-resolved. null when
// it doesn't resolve to a real shop code. Shared with the Estimated Balance
// upload (estimatedOpening.ts) so both uploads count OLD rows the same way.
export function resolveOldAccount(
  rawAccount: string,
  extractShopName: (raw: string) => string
): { account: string; shopCode: string } | null {
  const account = stripOldTag(rawAccount);
  if (!account) return null;
  const shopCode = extractShopName(account);
  if (!shopCode || shopCode === 'OLD' || shopCode === 'MANUAL' || !/[A-Z]+[0-9]+/i.test(shopCode)) return null;
  return { account, shopCode };
}

export function mergeOldRows(rows: BalanceLimitRow[], product: Product): BalanceLimitRow[] {
  const extractShopName = product === 'cashout' ? extractRealShopName : extractSendMoneyShopName;
  const bankKey = (r: BalanceLimitRow) => r.bank.trim().toUpperCase();
  const current = rows.filter((r) => r.shopCode !== 'OLD');

  const byShopBank = new Map<string, BalanceLimitRow[]>();
  const byLockedKey = new Map<string, BalanceLimitRow[]>();
  for (const r of current) {
    const k = `${r.shopCode}|${bankKey(r)}`;
    (byShopBank.get(k) ?? byShopBank.set(k, []).get(k)!).push(r);
    const lk = product === 'sendmoney' ? lockedMergeKey(r) : null;
    if (lk) (byLockedKey.get(lk) ?? byLockedKey.set(lk, []).get(lk)!).push(r);
  }

  const additions = new Map<BalanceLimitRow, { dp: number; wd: number }>();
  const keptOld: BalanceLimitRow[] = [];
  for (const old of rows) {
    if (old.shopCode !== 'OLD') continue;
    if (!isValidAmount(old.totalDP) || !isValidAmount(old.totalWD)) continue;
    const dp = parseAmount(old.totalDP);
    const wd = parseAmount(old.totalWD);
    if (dp === 0 && wd === 0) continue;
    const real = resolveOldAccount(old.rawAccount, extractShopName);
    if (!real) continue;
    const shopCode = real.shopCode;

    const resolved: BalanceLimitRow = { ...old, rawAccount: real.account, shopCode };
    const lk = product === 'sendmoney' ? lockedMergeKey(resolved) : null;
    const candidates = (byShopBank.get(`${shopCode}|${bankKey(old)}`) ?? (lk ? byLockedKey.get(lk) : undefined) ?? [])
      .filter((r) => isValidAmount(r.totalDP) && isValidAmount(r.totalWD));
    const target = candidates.find((r) => /^active$/i.test(r.rawStatus)) ?? candidates[0];

    if (target) {
      const sum = additions.get(target) ?? { dp: 0, wd: 0 };
      additions.set(target, { dp: sum.dp + dp, wd: sum.wd + wd });
    } else {
      keptOld.push({ ...resolved, balance: '0' });
    }
  }

  const merged = current.map((r) => {
    const add = additions.get(r);
    if (!add) return r;
    return { ...r, totalDP: String(parseAmount(r.totalDP) + add.dp), totalWD: String(parseAmount(r.totalWD) + add.wd) };
  });
  return [...merged, ...keptOld];
}
