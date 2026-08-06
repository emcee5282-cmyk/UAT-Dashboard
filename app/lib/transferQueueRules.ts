// Single source of truth for "which Transfer Queue group should this wallet be in" —
// replaces 4 hand-duplicated copies (app/lib/transferQueueCount.ts's Cashout + Send
// Money resolvers, app/transfer-queue/page.tsx's resolveCorrectGroup,
// app/sendmoney/transfer-queue/page.tsx's resolveCorrectGroup). Thresholds come from
// Transfer Queue Configuration (RuleRow[], fetched via
// /api/configurations/transfer-queue-settings/effective) — but every per-brand group
// NAME template below stays hardcoded verbatim, byte-for-byte identical to the
// original BASES arrays, since Configuration only ever decides WHEN a wallet crosses
// into a group, never WHAT it's called.

// cashout_sh_* — the SH-based sections, mirroring app/lib/transferQueueSettings.ts's
// own union. Confirmed live (2026-08-05): 5,173 of 5,174 "SSP AG BalanceLimit" rows
// already carry an "SH-" prefixed current-group label (e.g. "SH- Day DP+WD
// (8AM-10PM)") — the brand-based sections below them were never updated to
// recognize that format, so resolveCashoutCorrectGroup was returning null for
// virtually every Cashout shop and the live Transfer Queue was showing 0 entries.
// sendmoney_sh_247/sendmoney_sh_day — Send Money's own SH-based sections.
// Confirmed live (2026-08-05): every current-group label on the real "SSP
// PS BalanceLimit" sheet is already SH-prefixed too (e.g. "SH- Day Solo
// DP+WD", "SH- 24/7 Bundle DP Only") — resolveSendMoneyCorrectGroup only
// recognized the old brand-based format and explicitly excluded 'SH', so
// it was returning null for virtually every Send Money shop and the live
// queue was showing 0 entries, same failure mode Cashout had.
export type RuleSection =
  | 'cashout_day' | 'cashout_extended' | 'cashout_247'
  | 'cashout_sh_day' | 'cashout_sh_early_extended' | 'cashout_sh_extended' | 'cashout_sh_247'
  | 'sendmoney_247' | 'sendmoney_bd'
  | 'sendmoney_sh_247' | 'sendmoney_sh_day';
export type Operator = 'Greater Than' | 'Greater Than or Equal' | 'Less Than' | 'Less Than or Equal' | 'Between' | 'Equal';
// 'Cashout Account Balance' — Send Money Bundle rows only: the linked
// Cashout account's own Company Balance, looked up via the "Transfer Queue
// Configurations" sheet's U:V reference table (Send Money wallet -> Cashout
// account), read by readLinkedCashoutAccounts() in transferQueueSettings.ts.
export type Metric = 'SDP VS Balance' | 'Discrepancy' | 'Company Balance' | 'Cashout Account Balance';

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

function metricValue(metric: Metric, companyBalance: number, sdpVsBalance: number, discrepancy: number, cashoutAccountBalance: number): number {
  if (metric === 'Company Balance') return companyBalance;
  if (metric === 'SDP VS Balance') return sdpVsBalance;
  if (metric === 'Cashout Account Balance') return cashoutAccountBalance;
  return discrepancy;
}

// Generic, operator-respecting evaluator — an admin flipping an Operator or Value on an
// existing row genuinely takes effect, not just the number. Returns false immediately if
// the row is disabled — exactly what `enabled` was built for. `cashoutAccountBalance`
// defaults to 0 for every caller except the new Send Money Bundle path, which is the
// only place a "Cashout Account Balance" metric row can ever actually appear.
export function evaluateRule(row: RuleRow, companyBalance: number, sdpVsBalance: number, discrepancy: number, cashoutAccountBalance = 0): boolean {
  if (!row.enabled) return false;
  const value = metricValue(row.metric, companyBalance, sdpVsBalance, discrepancy, cashoutAccountBalance);
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
    case 'Cashout Account Balance':
      if (row.operator === 'Less Than' || row.operator === 'Less Than or Equal') return `Linked Cashout account balance is below ${fmt(row.value1)}`;
      return `Linked Cashout account balance exceeded ${fmt(row.value1)}`;
  }
}

// --- Cashout ---

const CASHOUT_BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

export function normalizeGroup(s: string): string {
  // Live "Current Group" labels sometimes carry a trailing schedule window,
  // e.g. "SH- Extended Day WD Only (7AM-11PM)" — the configured queueResult
  // never includes this, so strip parenthetical text before comparing or a
  // correctly-grouped shop gets falsely flagged as needing a transfer.
  return s.replace(/\([^)]*\)/g, '').toUpperCase().replace(/[\s-]+/g, '');
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

// Legacy brand-based path — kept for any shop still on the old "M1 SOLO DAY"
// / "B4-SOLO - 24/7 DP + WD" style label (confirmed live: only 1 of 5,174
// Cashout rows still uses this format as of 2026-08-05). resolveCashout
// CorrectGroup below tries the SH-based path first and only falls back to
// this for labels that aren't SH-prefixed.
function resolveCashoutCorrectGroupLegacy(
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

// --- SH-based (schedule-driven) path — the real, current format ---

type SHScheduleSection = 'cashout_sh_day' | 'cashout_sh_early_extended' | 'cashout_sh_extended' | 'cashout_sh_247';

// Order matters: "EARLY DAY"/"EXTENDED DAY" must be checked before the bare
// "DAY" check below them, since both contain "DAY" as a substring — a plain
// `includes('DAY')` first would misclassify every Early/Extended shop as
// vanilla Day. Static groups (Wallet with Issue / DC Account / Top up only)
// return 'static' — per explicit instruction these are never reassigned by
// this resolver; Top Up's own threshold rules haven't been provided yet.
function determineSHScheduleSection(rawGroup: string): SHScheduleSection | 'static' | null {
  const upper = rawGroup.trim().toUpperCase();
  if (!upper.startsWith('SH')) return null;

  if (upper.includes('WALLET WITH ISSUE') || upper.includes('DC ACCOUNT')) return 'static';
  if (upper.includes('TOP UP') || upper.includes('TOP-UP') || upper.includes('TOPUP')) return 'static';

  if (upper.includes('EARLY')) return 'cashout_sh_early_extended';
  if (upper.includes('EXTENDED')) return 'cashout_sh_extended';
  if (upper.includes('24/7')) return 'cashout_sh_247';
  if (upper.includes('DAY')) return 'cashout_sh_day';
  return null;
}

// Generic, priority-order evaluator — unlike the legacy path above (which
// needed separate per-brand GROUP_NAMES templates since the same rule shape
// produced different labels per brand), every SH rule's `queueResult` IS
// already the exact, final group name to use — nothing else to template.
// Rows are evaluated in their own stored order (first match wins), which is
// also why DEFAULT_RULES lists Discrepancy/SDP rows before the plain
// Company Balance buckets for each SH section, mirroring the legacy path's
// same "discrepancy checked first" priority.
function resolveSHShape(rows: RuleRow[], companyBalance: number, sdpVsBalance: number, discrepancy: number): ResolvedGroup | null {
  for (const row of rows) {
    if (evaluateRule(row, companyBalance, sdpVsBalance, discrepancy)) {
      return { groupName: row.queueResult, remarks: reasonForRow(row) };
    }
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
  const trimmed = rawGroup.trim();
  if (!trimmed || trimmed === '-') return null;

  const shSection = determineSHScheduleSection(trimmed);
  if (shSection === 'static') return null;
  if (shSection !== null) {
    return resolveSHShape(sectionRows(rules, shSection), companyBalance, sdpVsBalance, discrepancy);
  }

  return resolveCashoutCorrectGroupLegacy(trimmed, companyBalance, sdpVsBalance, discrepancy, rules);
}

// --- Send Money ---

// sendmoney_247 row order (fixed, 4 rows): [0] SDP > X -> WD Only, [1] Discrepancy > X
// -> WD Only, [2] Company Balance > X -> WD Only, [3] Company Balance < X -> DP + WD.
// This is a plain sequential if-chain today (no specialRule/fallback split) and already
// matches Configuration's row order 1:1.
function resolveSendMoneyCorrectGroupLegacy(
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

// --- SH-based (schedule-driven) path — the real, current format ---

type SMScheduleSection = 'sendmoney_sh_247' | 'sendmoney_sh_day';

// Static groups (DC Account / Wallet with Issue) are never reassigned by
// this resolver — same "leave alone" convention as Cashout's own SH path.
function determineSMScheduleSection(rawGroup: string): SMScheduleSection | 'static' | null {
  const upper = rawGroup.trim().toUpperCase();
  if (!upper.startsWith('SH')) return null;
  if (upper.includes('WALLET WITH ISSUE') || upper.includes('DC ACCOUNT')) return 'static';
  if (upper.includes('24/7')) return 'sendmoney_sh_247';
  if (upper.includes('DAY')) return 'sendmoney_sh_day';
  return null;
}

// Bundle (BD-tagged) wallets only ever evaluate a section's Bundle rows
// (metric "Cashout Account Balance"); every other wallet ("Solo") only
// ever evaluates that section's Solo rows — the two never cross, matching
// the spec's "Bundle DP Only... determined by the linked Cashout Account
// Balance only" (never by this account's own SDP/Discrepancy/Company
// Balance, and vice versa for Solo wallets).
function resolveSendMoneyCorrectGroupSH(
  rawGroup: string,
  walletName: string,
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number,
  cashoutAccountBalance: number | null,
  rules: RuleRow[]
): ResolvedGroup | null {
  const section = determineSMScheduleSection(rawGroup);
  if (section === null || section === 'static') return null;

  const isBundle = walletName.toUpperCase().includes('BD');
  const rows = sectionRows(rules, section);

  for (const row of rows) {
    const isBundleRow = row.metric === 'Cashout Account Balance';
    if (isBundleRow !== isBundle) continue;
    // No linked Cashout account found (or it doesn't resolve to a live
    // agent) — can't evaluate a Bundle row without a real balance to
    // check, so this Bundle wallet is simply left unmatched rather than
    // guessed at.
    if (isBundleRow && cashoutAccountBalance === null) continue;
    if (evaluateRule(row, companyBalance, sdpVsBalance, discrepancy, cashoutAccountBalance ?? 0)) {
      return { groupName: row.queueResult, remarks: reasonForRow(row) };
    }
  }
  return null;
}

// `cashoutAccountBalance`: the linked Cashout account's Company Balance
// (via readLinkedCashoutAccounts' U:V reference table), null if this
// wallet has no linked-account entry or that entry doesn't resolve to a
// live Cashout agent — irrelevant for Solo (non-BD) wallets either way.
export function resolveSendMoneyCorrectGroup(
  rawGroup: string,
  walletName: string,
  brand: string,
  companyBalance: number,
  sdpVsBalance: number,
  discrepancy: number,
  cashoutAccountBalance: number | null,
  rules: RuleRow[]
): ResolvedGroup | null {
  const trimmed = rawGroup.trim();
  if (trimmed.toUpperCase().startsWith('SH')) {
    return resolveSendMoneyCorrectGroupSH(trimmed, walletName, companyBalance, sdpVsBalance, discrepancy, cashoutAccountBalance, rules);
  }
  return resolveSendMoneyCorrectGroupLegacy(brand, companyBalance, sdpVsBalance, discrepancy, rules);
}

// The "BD" keyword exclusion — legacy-path-only gate now (per explicit
// instruction, SH-labeled Bundle wallets are evaluated via the Cashout
// Account Balance path above instead of a blanket exclusion; the caller
// only invokes this for the non-SH branch — see
// app/sendmoney/transfer-queue/page.tsx). Layered on top of the legacy
// path: if an enabled sendmoney_bd rule matches, the wallet escapes the
// exclusion and flows into resolveSendMoneyCorrectGroupLegacy above.
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
