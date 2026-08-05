import { rawVal } from '@/app/lib/format';
import { parseCsvLines } from '@/app/lib/csv';
import { getBusinessToday } from '@/app/lib/businessDate';
import {
  resolveCashoutCorrectGroup,
  resolveSendMoneyCorrectGroup as resolveSendMoneyGroup,
  shouldExcludeBdWallet,
  normalizeGroup,
  type RuleRow,
} from '@/app/lib/transferQueueRules';
import { computeCashoutCompanyBalanceByAgent } from '@/app/lib/cashoutAgentBalance';

async function fetchEffectiveTransferQueueRules(): Promise<RuleRow[]> {
  const res = await fetch(`/api/configurations/transfer-queue-settings/effective?t=${Date.now()}`);
  if (!res.ok) throw new Error('Failed to fetch Transfer Queue configuration');
  const data: { rules: RuleRow[] } = await res.json();
  return data.rules;
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function normalizeWalletStatus(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const lower = trimmed.toLowerCase();
  const noSpaces = trimmed.replace(/\s+/g, '').toLowerCase();
  if (noSpaces.includes('dp+wd')) return 'DP+WD';
  if (lower.includes('dp only')) return 'DP Only';
  if (lower.includes('wd only')) return 'WD Only';
  if (lower.includes('top up')) return 'Top Up Acc.';
  if (lower.includes('wallet with issue')) return 'Wallet With Issue';
  if (lower.includes('x group') || lower.includes('disconnected')) return 'Disconnected';
  if (lower.includes('check account problem')) return 'Account Problem';
  return 'Disconnected';
}

function computeWalletStatus(statuses: string[]): string {
  const normalized = statuses
    .map((s) => normalizeWalletStatus(s))
    .filter((s): s is string => s !== null);

  if (normalized.length === 0) return 'Disconnected';

  const has = (label: string) => normalized.includes(label);

  if (has('DP+WD')) return 'DP + WD';
  if (has('DP Only') && has('WD Only')) return 'DP + WD';
  if (has('DP Only')) return 'DP Only';
  if (has('WD Only')) return 'WD Only';
  if (has('Top Up Acc.')) return 'Top Up Acc.';
  if (has('Wallet With Issue')) return 'Wallet With Issue';
  if (has('Account Problem')) return 'Account Problem';

  return 'Disconnected';
}

const EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE',
  'MUNIM', 'NIHJUM', 'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN',
  'ROSE', 'SAM', 'XYZ', 'SHAKIL', 'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR',
];

function computeSdpVsBalance(leader: string, sdpRaw: string, sdpNum: number, companyBalance: number): number {
  const normalizedLeader = leader.trim().toUpperCase();
  if (EXCLUDED_SDP_LEADERS.includes(normalizedLeader)) return 0;

  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  const value = sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;

  if (value < 30000) return 0;
  if (companyBalance <= 0) return 0;

  return value;
}

const EXCLUDED_WALLET_STATUSES = ['Wallet With Issue', 'Disconnected', 'No Record'];

export const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

// "To Agent" values on "AG BD STLM + TOPUP" sometimes carry a trailing
// "-<brand>" suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") —
// strip it so the bare code matches Opening AG's own (always-bare) agent names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

export async function fetchTransferQueueCount(): Promise<number> {
  const [openingRes, balRes, stlmRes, rules] = await Promise.all([
    fetch(`/api/opening?t=${Date.now()}`),
    fetch(`/api/agentbal?t=${Date.now()}`),
    fetch(`/api/agstlmtopup?t=${Date.now()}`),
    fetchEffectiveTransferQueueRules(),
  ]);

  if (!openingRes.ok || !balRes.ok || !stlmRes.ok) throw new Error('Failed to fetch');

  const openingText = await openingRes.text();
  const balText = await balRes.text();
  const stlmText = await stlmRes.text();

  const openingRows = parseCsvLines(openingText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => ({
      agentName: rawVal(row[0]),
      openingBal: rawVal(row[1]),
      sdp: rawVal(row[2]),
      leader: rawVal(row[3]),
    }))
    .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

  const balRows = parseCsvLines(balText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => ({
      walletName: rawVal(row[1]),
      totalDP: rawVal(row[11]),
      totalWD: rawVal(row[13]),
      balance: rawVal(row[8]),
      login: rawVal(row[15]),
      accountStatus: rawVal(row[2]),
      group: rawVal(row[6]),
    }))
    .filter((row) => row.walletName && row.walletName !== '-');

  const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
  const balanceTotals = new Map<string, { dp: number; wd: number }>();
  const balanceInsideTotals = new Map<string, number>();
  const walletStatusValues = new Map<string, string[]>();
  balRows.forEach((bal) => {
    const name = bal.walletName;
    const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
    const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
    const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
    balanceTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

    if (bal.accountStatus && bal.accountStatus !== '-') {
      const statuses = walletStatusValues.get(name) ?? [];
      statuses.push(bal.accountStatus);
      walletStatusValues.set(name, statuses);
    }

    if (bal.login.trim().toLowerCase() === 'yes') {
      const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
      balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
    }
  });

  // "AG BD STLM + TOPUP" is Cashout's own dedicated Settlement + Top Up
  // sheet (replaces the old shared "Stlm Top Up" source). Top Up lives in
  // cols B-F (indices 1-5): To Agent/Amount/Date/Wallet/Type, amounts
  // stored positive. Settlement lives in cols H-L (indices 7-11), same
  // field order, amounts stored negative (money leaving) so they're
  // abs()'d. Cols Q-AA are a last-month archive and are not read.
  const topUpTotals = new Map<string, number>();
  const stlmTotals = new Map<string, number>();
  parseCsvLines(stlmText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .forEach((row) => {
      const topUpAgent = stripBrandSuffix(rawVal(row[1]));
      const topUpAmount = rawVal(row[2]);
      if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-') {
        const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
        topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
      }

      const stlmAgent = stripBrandSuffix(rawVal(row[7]));
      const stlmAmount = rawVal(row[8]);
      if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-') {
        const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
        stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
      }
    });

  const agentInfo = new Map<string, { companyBalance: number; sdpVsBalance: number; discrepancy: number; walletStatus: string }>();
  openingRows.forEach((opening) => {
    const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
    const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
    const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
    const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
    const companyBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
    const sdpNum = parseNumber(opening.sdp);
    const walletStatus = balWalletNames.has(opening.agentName)
      ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
      : 'No Record';

    agentInfo.set(opening.agentName, {
      companyBalance,
      sdpVsBalance: computeSdpVsBalance(opening.leader, opening.sdp, sdpNum, companyBalance),
      discrepancy: companyBalance - balanceInside,
      walletStatus,
    });
  });

  let count = 0;
  balRows.forEach((bal) => {
    const info = agentInfo.get(bal.walletName);
    if (!info) return;
    if (EXCLUDED_WALLET_STATUSES.includes(info.walletStatus)) return;

    const currentGroup = bal.group.trim();
    if (currentGroup.toLowerCase().includes('top up')) return;
    const resolved = resolveCashoutCorrectGroup(currentGroup, info.companyBalance, info.sdpVsBalance, info.discrepancy, rules);
    if (!resolved) return;
    if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

    count += 1;
  });

  return count;
}

// --- Send Money's own Transfer Queue count (app/sendmoney/transfer-queue/page.tsx) ---
// Mirrors that page's ruleset exactly (genuinely different from Cashout's — see
// comments there): no DAY variant, every brand has exactly two possible correct
// groups, and 'SH' (Sharing) is never queued. Reuses parseCsvLines/parseNumber/
// normalizeWalletStatus/computeWalletStatus/EXCLUDED_WALLET_STATUSES/normalizeGroup
// above since those are byte-identical between the two pages.

function parseSendMoneySheetDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

// No Send Money leaders are excluded — Cashout's exclusion list doesn't carry
// over (different leader roster).
function computeSendMoneySdpVsBalanceRaw(sdpRaw: string, sdpNum: number, companyBalance: number): number {
  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  return sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;
}

const SEND_MONEY_BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
const SEND_MONEY_SKIP_GROUPS = ['wallet with issue', 'disconnected', 'dc account'];
const SEND_MONEY_BRAND_CODES = [...BRAND_CODES, 'SH'];

function computeSendMoneyBrand(groups: string[]): string {
  const counts = new Map<string, number>();
  groups.forEach((group) => {
    const trimmed = (group ?? '').trim();
    if (!trimmed || trimmed === '-') return;
    if (SEND_MONEY_SKIP_GROUPS.some((skip) => trimmed.toLowerCase().includes(skip))) return;
    const code = trimmed.slice(0, 2).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  });

  if (counts.size === 0) return '−';

  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.keys()).filter((code) => counts.get(code) === maxCount);
  const priorityTied = tied.filter((code) => SEND_MONEY_BRAND_PRIORITY.includes(code));

  if (priorityTied.length > 0) {
    priorityTied.sort((a, b) => SEND_MONEY_BRAND_PRIORITY.indexOf(a) - SEND_MONEY_BRAND_PRIORITY.indexOf(b));
    return priorityTied[0];
  }

  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

function resolveSendMoneyBrand(groups: string[], agentName: string): string {
  const brand = computeSendMoneyBrand(groups);
  if (brand !== '−' && SEND_MONEY_BRAND_CODES.includes(brand)) return brand;
  return SEND_MONEY_BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

export async function fetchSendMoneyTransferQueueCount(): Promise<number> {
  const [openingRes, balRes, stlmRes, agentBalRes, agstlmRes, linkedAccountsRes, rules] = await Promise.all([
    fetch(`/api/opening?t=${Date.now()}`),
    fetch(`/api/sendmoney/balances?t=${Date.now()}`),
    fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
    fetch(`/api/agentbal?t=${Date.now()}`),
    fetch(`/api/agstlmtopup?t=${Date.now()}`),
    fetch(`/api/configurations/transfer-queue-settings/linked-accounts?t=${Date.now()}`),
    fetchEffectiveTransferQueueRules(),
  ]);

  if (!openingRes.ok || !balRes.ok || !stlmRes.ok || !agentBalRes.ok || !agstlmRes.ok || !linkedAccountsRes.ok) throw new Error('Failed to fetch');

  const openingText = await openingRes.text();
  const balData: string[][] = await balRes.json();
  const stlmText = await stlmRes.text();
  // Send Money Bundle (BD) wallets are evaluated against their linked
  // Cashout account's own Company Balance, not this account's own figures
  // — see app/lib/cashoutAgentBalance.ts's own header comment for why this
  // computation is shared instead of re-derived here.
  const cashoutCompanyBalanceByAgent = computeCashoutCompanyBalanceByAgent(openingText, await agentBalRes.text(), await agstlmRes.text());
  const linkedAccounts: Record<string, string> = await linkedAccountsRes.json();

  const openingRawRows = parseCsvLines(openingText);
  // Top Up/Settlement totals reset at the 2AM business-day rollover (see
  // app/lib/businessDate.ts) — clock-based, not gated on whether Opening's
  // own "Updated Time" card has been manually refreshed yet.
  const reportCutoffDate = getBusinessToday();

  // Send Money's own roster lives in cols L-O (indices 11-14) of "Opening AG".
  const openingRows = openingRawRows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => ({
      agentName: rawVal(row[11]),
      openingBal: rawVal(row[12]),
      sdp: rawVal(row[13]),
    }))
    .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

  // "SSP PS BalanceLimit" lines up with Cashout's own Balance Limit sheet
  // from index 4 onward, just without Cashout's leading "Reference" column.
  const balRows = balData
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => ({
      walletName: rawVal(row[0]),
      totalDP: rawVal(row[11]),
      totalWD: rawVal(row[13]),
      balance: rawVal(row[8]),
      login: rawVal(row[15]),
      accountStatus: rawVal(row[1]),
      group: rawVal(row[6]),
    }))
    .filter((row) => row.walletName && row.walletName !== '-');

  const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
  const balanceTotals = new Map<string, { dp: number; wd: number }>();
  const balanceInsideTotals = new Map<string, number>();
  const walletStatusValues = new Map<string, string[]>();
  const brandGroups = new Map<string, string[]>();
  balRows.forEach((bal) => {
    const name = bal.walletName;
    const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
    const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
    const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
    balanceTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

    if (bal.group && bal.group !== '-') {
      const groups = brandGroups.get(name) ?? [];
      groups.push(bal.group);
      brandGroups.set(name, groups);
    }

    if (bal.accountStatus && bal.accountStatus !== '-') {
      const statuses = walletStatusValues.get(name) ?? [];
      statuses.push(bal.accountStatus);
      walletStatusValues.set(name, statuses);
    }

    if (bal.login.trim().toLowerCase() === 'yes') {
      const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
      balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
    }
  });

  // "PS BD STLM + TOPUP" is Send Money's own dedicated sheet. Top Up lives in
  // cols B-F (indices 1-5), positive amounts; Settlement lives in cols H-L
  // (indices 7-11), negative amounts (abs()'d) — same cutoff-date filtering
  // as /sendmoney/balances so rows already folded into the last Opening
  // Balance reset aren't double-counted.
  const topUpTotals = new Map<string, number>();
  const stlmTotals = new Map<string, number>();
  parseCsvLines(stlmText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .forEach((row) => {
      const topUpAgent = rawVal(row[1]);
      const topUpAmount = rawVal(row[2]);
      const topUpDate = reportCutoffDate ? parseSendMoneySheetDate(rawVal(row[3])) : null;
      if (
        topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
        (!reportCutoffDate || (topUpDate && topUpDate >= reportCutoffDate))
      ) {
        const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
        topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
      }

      const stlmAgent = rawVal(row[7]);
      const stlmAmount = rawVal(row[8]);
      const stlmDate = reportCutoffDate ? parseSendMoneySheetDate(rawVal(row[9])) : null;
      if (
        stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
        (!reportCutoffDate || (stlmDate && stlmDate >= reportCutoffDate))
      ) {
        const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
        stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
      }
    });

  const agentInfo = new Map<string, { companyBalance: number; sdpVsBalance: number; discrepancy: number; walletStatus: string; brand: string }>();
  openingRows.forEach((opening) => {
    const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
    const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
    const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
    const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
    const companyBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
    const sdpNum = parseNumber(opening.sdp);
    const walletStatus = balWalletNames.has(opening.agentName)
      ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
      : 'No Record';

    agentInfo.set(opening.agentName, {
      companyBalance,
      sdpVsBalance: computeSendMoneySdpVsBalanceRaw(opening.sdp, sdpNum, companyBalance),
      discrepancy: companyBalance - balanceInside,
      walletStatus,
      brand: resolveSendMoneyBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName),
    });
  });

  let count = 0;
  balRows.forEach((bal) => {
    const info = agentInfo.get(bal.walletName);
    if (!info) return;
    if (EXCLUDED_WALLET_STATUSES.includes(info.walletStatus)) return;

    const currentGroup = bal.group.trim();
    if (currentGroup.toLowerCase().includes('top up')) return;

    // SH-prefixed labels (virtually every real Send Money shop today) skip
    // the legacy BD-exclusion gate entirely — Bundle wallets are evaluated
    // via their linked Cashout account's balance instead. Only a
    // non-SH-prefixed label falls back to the old keyword-exclusion path.
    if (currentGroup.toUpperCase().startsWith('SH')) {
      const linkedTo = linkedAccounts[bal.walletName.toUpperCase()];
      const cashoutAccountBalance = linkedTo ? (cashoutCompanyBalanceByAgent.get(linkedTo) ?? null) : null;
      const resolved = resolveSendMoneyGroup(currentGroup, bal.walletName, info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy, cashoutAccountBalance, rules);
      if (!resolved) return;
      if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;
      count += 1;
      return;
    }

    // Shops whose wallet name carries a "BD" segment are excluded from the
    // Transfer Queue by default (keyword gate, always checked first) — unless an
    // enabled BD Limit Configuration rule says otherwise (point 14).
    if (shouldExcludeBdWallet(bal.walletName, info.companyBalance, info.sdpVsBalance, info.discrepancy, rules)) return;
    const resolved = resolveSendMoneyGroup(currentGroup, bal.walletName, info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy, null, rules);
    if (!resolved) return;
    if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

    count += 1;
  });

  return count;
}
