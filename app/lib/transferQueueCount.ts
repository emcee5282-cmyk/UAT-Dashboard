import { rawVal } from '@/app/lib/format';

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
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

type Condition = {
  sdpGt30000?: boolean;
  discrepancyGt20000?: boolean;
  companyBalanceLt20000?: boolean;
  companyBalanceLt90000?: boolean;
  companyBalanceBetween35kAnd180k?: boolean;
  companyBalanceGt200000?: boolean;
  companyBalanceGt90000?: boolean;
};

type Rule = { groupName: string; condition: Condition };
type Base = { base: string; rules: Rule[] };

const SOLO_DAY = (prefix: string): Rule[] => [
  { groupName: `${prefix}-SOLO - DAY DP + WD`, condition: { companyBalanceLt90000: true } },
  { groupName: `${prefix}-SOLO - DAY WD`, condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
];

const SOLO_247 = (prefix: string): Rule[] => [
  { groupName: `${prefix}-SOLO- 24/7 Low balance DP Only`, condition: { companyBalanceLt20000: true } },
  { groupName: `${prefix}-SOLO - 24/7 DP + WD`, condition: { companyBalanceBetween35kAnd180k: true } },
  { groupName: `${prefix}-SOLO- 24/7 WD Only`, condition: { companyBalanceGt200000: true } },
  { groupName: `${prefix}-SOLO - 24/7 Discrepancy / Clear Balance`, condition: { sdpGt30000: true, discrepancyGt20000: true } },
];

const BASES: Base[] = [
  { base: 'B1 SOLO DAY', rules: SOLO_DAY('B1') },
  { base: 'B1 SOLO 24/7', rules: SOLO_247('B1') },

  { base: 'B2 SOLO DAY', rules: SOLO_DAY('B2') },
  { base: 'B2 SOLO 24/7', rules: SOLO_247('B2') },

  { base: 'B3 SOLO 24/7', rules: SOLO_247('B3') },

  { base: 'B4 SOLO DAY', rules: SOLO_DAY('B4') },
  { base: 'B4 SOLO 24/7', rules: SOLO_247('B4') },

  { base: 'B5 SOLO DAY', rules: SOLO_DAY('B5') },
  { base: 'B5 SOLO 24/7', rules: SOLO_247('B5') },

  { base: 'J1 SOLO DAY', rules: SOLO_DAY('J1') },
  { base: 'J1 SOLO 24/7', rules: SOLO_247('J1') },

  {
    base: 'K1 SOLO DAY',
    rules: [
      { groupName: 'K1 - SOLO - DAY DP + WD', condition: { companyBalanceLt90000: true } },
      { groupName: 'K1 - SOLO - DAY WD', condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
    ],
  },
  { base: 'K1 SOLO 24/7', rules: SOLO_247('K1') },

  {
    base: 'M1 Day',
    rules: [
      { groupName: 'M1 - Day Low balance DP Only', condition: { companyBalanceLt20000: true } },
      { groupName: 'M1 - Day DP + WD', condition: { companyBalanceBetween35kAnd180k: true } },
      { groupName: 'M1 - Day WD Only', condition: { companyBalanceGt200000: true } },
      { groupName: 'M1 - Day Discrepancy / Clear Balance', condition: { sdpGt30000: true, discrepancyGt20000: true } },
    ],
  },
  {
    base: 'M1 24/7',
    rules: [
      { groupName: 'M1 - 24/7 Low Balance DP Only', condition: { companyBalanceLt20000: true } },
      { groupName: 'M1 - 24/7 DP + WD', condition: { companyBalanceBetween35kAnd180k: true } },
      { groupName: 'M1 - 24/7 WD Only', condition: { companyBalanceGt200000: true } },
      { groupName: 'M1 - 24/7 Discrepancy / Clear Balance', condition: { sdpGt30000: true, discrepancyGt20000: true } },
    ],
  },

  {
    base: 'M2 SOLO DAY',
    rules: [
      { groupName: 'M2 - SOLO - DAY DP + WD', condition: { companyBalanceLt90000: true } },
      { groupName: 'M2 - SOLO - DAY WD', condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
    ],
  },
  { base: 'M2 SOLO 24/7', rules: SOLO_247('M2') },

  { base: 'T1 SOLO DAY', rules: SOLO_DAY('T1') },
  { base: 'T1 SOLO 24/7', rules: SOLO_247('T1') },
];

export const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function normalizeGroup(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

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

function determineBaseLabel(rawGroup: string): string | null {
  const trimmed = rawGroup.trim();
  if (!trimmed || trimmed === '-') return null;

  const upper = trimmed.toUpperCase();
  const noSpaces = upper.replace(/[\s-]+/g, '');
  const code = BRAND_CODES.find((c) => noSpaces.startsWith(c));
  if (!code) return null;

  const is247 = upper.includes('24/7');
  const isDay = upper.includes('DAY');
  if (!is247 && !isDay) return null;
  const period = is247 ? '24/7' : 'DAY';

  if (code === 'M1') return period === 'DAY' ? 'M1 Day' : 'M1 24/7';
  return `${code} SOLO ${period}`;
}

function checkCondition(condition: Condition, companyBalance: number, sdpVsBalance: number, discrepancy: number): boolean {
  if (condition.sdpGt30000 && !(sdpVsBalance > 30000)) return false;
  if (condition.discrepancyGt20000 && !(discrepancy > 20000)) return false;
  if (condition.companyBalanceLt20000 && !(companyBalance < 20000)) return false;
  if (condition.companyBalanceLt90000 && !(companyBalance < 90000)) return false;
  if (condition.companyBalanceBetween35kAnd180k && !(companyBalance >= 35000 && companyBalance <= 180000)) return false;
  if (condition.companyBalanceGt200000 && !(companyBalance > 200000)) return false;
  if (condition.companyBalanceGt90000 && !(companyBalance > 90000)) return false;
  return true;
}

function resolveCorrectGroupName(rawGroup: string, companyBalance: number, sdpVsBalance: number, discrepancy: number): string | null {
  const baseLabel = determineBaseLabel(rawGroup);
  if (!baseLabel) return null;

  const base = BASES.find((b) => b.base === baseLabel);
  if (!base) return null;

  const specialRule = base.rules.find((rule) => rule.condition.discrepancyGt20000 || rule.condition.sdpGt30000);
  if (specialRule && discrepancy > 20000) return specialRule.groupName;
  if (specialRule && sdpVsBalance > 30000) return specialRule.groupName;

  const balanceRules = base.rules.filter((rule) => !rule.condition.discrepancyGt20000 && !rule.condition.sdpGt30000);
  const matched = balanceRules.find((rule) => checkCondition(rule.condition, companyBalance, sdpVsBalance, discrepancy));
  return matched ? matched.groupName : null;
}

export async function fetchTransferQueueCount(): Promise<number> {
  const [openingRes, balRes, stlmRes] = await Promise.all([
    fetch(`/api/opening?t=${Date.now()}`),
    fetch(`/api/agentbal?t=${Date.now()}`),
    fetch(`/api/agstlmtopup?t=${Date.now()}`),
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
    const correctGroupName = resolveCorrectGroupName(currentGroup, info.companyBalance, info.sdpVsBalance, info.discrepancy);
    if (!correctGroupName) return;
    if (normalizeGroup(currentGroup) === normalizeGroup(correctGroupName)) return;

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

// Opening sheet col I holds Send Money's own "UPDATED TIME" card — Settlement
// rows dated before this reset point are excluded so they aren't double-counted.
function parseSendMoneyReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const cell = (row[8] ?? '').trim();
    const match = cell.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*\d{1,2}:\d{2}\s*[AP]M$/i);
    if (match) {
      const [, monthName, day] = match;
      const year = new Date().getFullYear();
      const parsed = new Date(`${monthName} ${day}, ${year}`);
      if (!isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        return parsed;
      }
    }
  }
  return null;
}

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

// Every brand has exactly two possible correct groups. Three independent
// triggers all point to WD Only (checked first, in this order): SDP VS
// Balance > 50,000, Discrepancy > 10,000, Company Balance > 45,000; Company
// Balance < 20,000 is the only DP + WD trigger. 'SH' has no rule.
function resolveSendMoneyCorrectGroup(brand: string, companyBalance: number, sdpVsBalance: number, discrepancy: number): string | null {
  if (!BRAND_CODES.includes(brand)) return null;

  if (sdpVsBalance > 50000) return `${brand} 24/7 WD Only`;
  if (discrepancy > 10000) return `${brand} 24/7 WD Only`;
  if (companyBalance > 45000) return `${brand} 24/7 WD Only`;
  if (companyBalance < 20000) return `${brand} 24/7 DP + WD`;

  return null;
}

export async function fetchSendMoneyTransferQueueCount(): Promise<number> {
  const [openingRes, balRes, stlmRes] = await Promise.all([
    fetch(`/api/opening?t=${Date.now()}`),
    fetch(`/api/sendmoney/balances?t=${Date.now()}`),
    fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
  ]);

  if (!openingRes.ok || !balRes.ok || !stlmRes.ok) throw new Error('Failed to fetch');

  const openingText = await openingRes.text();
  const balData: string[][] = await balRes.json();
  const stlmText = await stlmRes.text();

  const openingRawRows = parseCsvLines(openingText);
  const reportCutoffDate = parseSendMoneyReportCutoffDate(openingRawRows);

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
    // Shops whose wallet name carries a "BD" segment are excluded from the
    // Transfer Queue entirely, per user instruction (Transfer-Queue-specific).
    if (bal.walletName.toUpperCase().includes('BD')) return;
    const correctGroupName = resolveSendMoneyCorrectGroup(info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy);
    if (!correctGroupName) return;
    if (normalizeGroup(currentGroup) === normalizeGroup(correctGroupName)) return;

    count += 1;
  });

  return count;
}
