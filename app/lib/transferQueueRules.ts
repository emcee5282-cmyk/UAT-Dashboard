// Single source of truth for "which Transfer Queue group should this wallet be in" —
// replaces 4 hand-duplicated copies (app/lib/transferQueueCount.ts's Cashout + Send
// Money resolvers, app/transfer-queue/page.tsx's resolveCorrectGroup,
// app/sendmoney/transfer-queue/page.tsx's resolveCorrectGroup). Thresholds come from
// Transfer Queue Configuration (RuleRow[], fetched via
// /api/configurations/transfer-queue-settings/effective) — but every per-brand group
// NAME template below stays hardcoded verbatim, byte-for-byte identical to the
// original BASES arrays, since Configuration only ever decides WHEN a wallet crosses
// into a group, never WHAT it's called.

export type RuleSection = 'cashout_day' | 'cashout_extended' | 'cashout_247' | 'sendmoney_247' | 'sendmoney_bd';
export type Operator = 'Greater Than' | 'Greater Than or Equal' | 'Less Than' | 'Less Than or Equal' | 'Between' | 'Equal';
export type Metric = 'SDP VS Balance' | 'Discrepancy' | 'Company Balance';

export type RuleRow = {
  section: RuleSection;
  metric: Metric;
  operator: Operator;
  value1: number;
  value2: number | null;
  queueResult: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
};

export type ResolvedGroup = { groupName: string; remarks: string };

function metricValue(metric: Metric, companyBalance: number, sdpVsBalance: number, discrepancy: number): number {
  if (metric === 'Company Balance') return companyBalance;
  if (metric === 'SDP VS Balance') return sdpVsBalance;
  return discrepancy;
}

// Generic, operator-respecting evaluator — an admin flipping an Operator or Value on an
// existing row genuinely takes effect, not just the number. Returns false immediately if
// the row is disabled — exactly what `enabled` was built for.
export function evaluateRule(row: RuleRow, companyBalance: number, sdpVsBalance: number, discrepancy: number): boolean {
  if (!row.enabled) return false;
  const value = metricValue(row.metric, companyBalance, sdpVsBalance, discrepancy);
  switch (row.operator) {
    case 'Greater Than': return value > row.value1;
    case 'Greater Than or Equal': return value >= row.value1;
    case 'Less Than': return value < row.value1;
    case 'Less Than or Equal': return value <= row.value1;
    case 'Equal': return value === row.value1;
    case 'Between': return row.value2 !== null && value >= row.value1 && value <= row.value2;
    default: return false;
  }
}

function sectionRows(rules: RuleRow[], section: RuleSection): RuleRow[] {
  return rules.filter((r) => r.section === section);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function reasonForRow(row: RuleRow | undefined): string {
  if (!row) return '';
  switch (row.metric) {
    case 'Company Balance':
      if (row.operator === 'Between') return 'Company balance is within normal range';
      if (row.operator === 'Less Than' || row.operator === 'Less Than or Equal') return `Company balance is below ${fmt(row.value1)}`;
      return `Company balance exceeded ${fmt(row.value1)}`;
    case 'SDP VS Balance':
      return `SDP VS Balance exceeded ${fmt(row.value1)}`;
    case 'Discrepancy':
      return `Discrepancy is higher than ${fmt(row.value1)}`;
  }
}

// --- Cashout ---

const CASHOUT_BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

export function normalizeGroup(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

function determineBaseLabel(rawGroup: string): string | null {
  const trimmed = rawGroup.trim();
  if (!trimmed || trimmed === '-') return null;

  const upper = trimmed.toUpperCase();
  const noSpaces = upper.replace(/[\s-]+/g, '');
  const code = CASHOUT_BRAND_CODES.find((c) => noSpaces.startsWith(c));
  if (!code) return null;

  const is247 = upper.includes('24/7');
  const isDay = upper.includes('DAY');
  if (!is247 && !isDay) return null;
  const period = is247 ? '24/7' : 'DAY';

  if (code === 'M1') return period === 'DAY' ? 'M1 Day' : 'M1 24/7';
  return `${code} SOLO ${period}`;
}

// Every groupName string below is copied verbatim from the original BASES arrays in
// app/lib/transferQueueCount.ts / app/transfer-queue/page.tsx — including their
// inconsistent spacing (e.g. "B1-SOLO- 24/7 WD Only" vs "B1-SOLO - 24/7 DP + WD") and
// K1/M2's own differently-spaced Day labels — these quirks are real production label
// text, not bugs to "fix" here.
function soloDayGroupNames(prefix: string) {
  return { dpwd: `${prefix}-SOLO - DAY DP + WD`, wd: `${prefix}-SOLO - DAY WD` };
}
function solo247GroupNames(prefix: string) {
  return {
    low: `${prefix}-SOLO- 24/7 Low balance DP Only`,
    dpwd: `${prefix}-SOLO - 24/7 DP + WD`,
    wd: `${prefix}-SOLO- 24/7 WD Only`,
    disc: `${prefix}-SOLO - 24/7 Discrepancy / Clear Balance`,
  };
}

const K1_DAY_GROUP_NAMES = { dpwd: 'K1 - SOLO - DAY DP + WD', wd: 'K1 - SOLO - DAY WD' };
const M2_DAY_GROUP_NAMES = { dpwd: 'M2 - SOLO - DAY DP + WD', wd: 'M2 - SOLO - DAY WD' };
const M1_DAY_GROUP_NAMES = {
  low: 'M1 - Day Low balance DP Only',
  dpwd: 'M1 - Day DP + WD',
  wd: 'M1 - Day WD Only',
  disc: 'M1 - Day Discrepancy / Clear Balance',
};
const M1_247_GROUP_NAMES = {
  low: 'M1 - 24/7 Low Balance DP Only',
  dpwd: 'M1 - 24/7 DP + WD',
  wd: 'M1 - 24/7 WD Only',
  disc: 'M1 - 24/7 Discrepancy / Clear Balance',
};

// cashout_day row order (fixed, matches transferQueueSettings.ts's DEFAULT_RULES):
// [0] Company Balance < X -> DP+WD, [1] SDP > X -> WD, [2] Discrepancy > X -> WD,
// [3] Company Balance > X -> WD (never evaluated — see note below).
function resolveDayShape(
  names: { dpwd: string; wd: string },
  rows: RuleRow[],
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number
): ResolvedGroup | null {
  const lowBalanceRow = rows[0];
  const sdpRow = rows[1];
  const discrepancyRow = rows[2];
  // rows[3] (Company Balance > 90,000) is intentionally never evaluated. In the real
  // production code this condition was always fused into the SDP/Discrepancy rule's
  // compound AND-condition, which the "specialRule" shortcut bypasses entirely
  // (Discrepancy or SDP alone already trigger "WD", regardless of this threshold) — it
  // has never been an independently-reachable check. Keeping it inert here preserves
  // that exact real behavior instead of introducing a new one.

  // Priority matches today's exact order: Discrepancy checked first, then SDP, then
  // the Company Balance fallback — not simply "first row in list order wins".
  if (discrepancyRow && evaluateRule(discrepancyRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.wd, remarks: reasonForRow(discrepancyRow) };
  }
  if (sdpRow && evaluateRule(sdpRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.wd, remarks: reasonForRow(sdpRow) };
  }
  if (lowBalanceRow && evaluateRule(lowBalanceRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.dpwd, remarks: reasonForRow(lowBalanceRow) };
  }
  return null;
}

// cashout_extended / cashout_247 row order (fixed, 5 rows): [0] Company Balance < X ->
// Low Balance DP Only, [1] Company Balance Between X-Y -> DP+WD, [2] Company Balance > X
// -> WD Only, [3] SDP > X -> Discrepancy/Clear Balance, [4] Discrepancy > X -> same.
function resolveExtendedShape(
  names: { low: string; dpwd: string; wd: string; disc: string },
  rows: RuleRow[],
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number
): ResolvedGroup | null {
  const lowRow = rows[0];
  const betweenRow = rows[1];
  const highRow = rows[2];
  const sdpRow = rows[3];
  const discrepancyRow = rows[4];

  // Priority matches today's exact order: Discrepancy, then SDP (the specialRule
  // shortcut), THEN the Company Balance fallback rules in their original array order
  // (low, between, high).
  if (discrepancyRow && evaluateRule(discrepancyRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.disc, remarks: reasonForRow(discrepancyRow) };
  }
  if (sdpRow && evaluateRule(sdpRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.disc, remarks: reasonForRow(sdpRow) };
  }
  if (lowRow && evaluateRule(lowRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.low, remarks: reasonForRow(lowRow) };
  }
  if (betweenRow && evaluateRule(betweenRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.dpwd, remarks: reasonForRow(betweenRow) };
  }
  if (highRow && evaluateRule(highRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: names.wd, remarks: reasonForRow(highRow) };
  }
  return null;
}

export function resolveCashoutCorrectGroup(
  rawGroup: string,
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number,
  rules: RuleRow[]
): ResolvedGroup | null {
  const baseLabel = determineBaseLabel(rawGroup);
  if (!baseLabel) return null;

  if (baseLabel === 'M1 Day') {
    return resolveExtendedShape(M1_DAY_GROUP_NAMES, sectionRows(rules, 'cashout_extended'), companyBalance, sdpVsBalance, discrepancy);
  }
  if (baseLabel === 'M1 24/7') {
    return resolveExtendedShape(M1_247_GROUP_NAMES, sectionRows(rules, 'cashout_247'), companyBalance, sdpVsBalance, discrepancy);
  }

  const match = baseLabel.match(/^(\w+) SOLO (DAY|24\/7)$/);
  if (!match) return null;
  const [, code, period] = match;

  if (period === 'DAY') {
    const names = code === 'K1' ? K1_DAY_GROUP_NAMES : code === 'M2' ? M2_DAY_GROUP_NAMES : soloDayGroupNames(code);
    return resolveDayShape(names, sectionRows(rules, 'cashout_day'), companyBalance, sdpVsBalance, discrepancy);
  }

  return resolveExtendedShape(solo247GroupNames(code), sectionRows(rules, 'cashout_247'), companyBalance, sdpVsBalance, discrepancy);
}

// --- Send Money ---

// sendmoney_247 row order (fixed, 4 rows): [0] SDP > X -> WD Only, [1] Discrepancy > X
// -> WD Only, [2] Company Balance > X -> WD Only, [3] Company Balance < X -> DP + WD.
// This is a plain sequential if-chain today (no specialRule/fallback split) and already
// matches Configuration's row order 1:1.
export function resolveSendMoneyCorrectGroup(
  brand: string,
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number,
  rules: RuleRow[]
): ResolvedGroup | null {
  if (!CASHOUT_BRAND_CODES.includes(brand)) return null; // excludes 'SH', matches today

  const rows = sectionRows(rules, 'sendmoney_247');
  const sdpRow = rows[0];
  const discrepancyRow = rows[1];
  const highRow = rows[2];
  const lowRow = rows[3];

  if (sdpRow && evaluateRule(sdpRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: `${brand} 24/7 WD Only`, remarks: reasonForRow(sdpRow) };
  }
  if (discrepancyRow && evaluateRule(discrepancyRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: `${brand} 24/7 WD Only`, remarks: reasonForRow(discrepancyRow) };
  }
  if (highRow && evaluateRule(highRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: `${brand} 24/7 WD Only`, remarks: reasonForRow(highRow) };
  }
  if (lowRow && evaluateRule(lowRow, companyBalance, sdpVsBalance, discrepancy)) {
    return { groupName: `${brand} 24/7 DP + WD`, remarks: reasonForRow(lowRow) };
  }
  return null;
}

// The "BD" keyword exclusion stays the always-first, default-deny gate — reproduces
// today's exact behavior while the 2 sendmoney_bd rows stay disabled/blank. Layered on
// top: if an enabled sendmoney_bd rule matches, the wallet escapes the exclusion and
// flows into the normal resolveSendMoneyCorrectGroup evaluation above (a BD-tagged
// wallet still nominally belongs to a real brand, e.g. "M2BD-...", so its resulting
// label is that brand's own real template — never a separate "BD" label).
export function shouldExcludeBdWallet(
  walletName: string,
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number,
  rules: RuleRow[]
): boolean {
  if (!walletName.toUpperCase().includes('BD')) return false;

  const bdRows = sectionRows(rules, 'sendmoney_bd');
  const escapes = bdRows.some((row) => evaluateRule(row, companyBalance, sdpVsBalance, discrepancy));
  return !escapes;
}
