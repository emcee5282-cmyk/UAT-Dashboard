import type { OpeningImportRow } from './xlsxParser';
import { type ValidationEntry, type FieldCheckResult } from './settlementValidation';
import { parseAmount } from './format';

// Modeled on settlementValidation.ts's validateSettlementRows, but Opening
// Balance's row shape has no Brand/Wallet/Date/Type at all — a static
// roster snapshot (Agent Name/Leader/Opening Balance/Security Deposit), not
// a per-transaction record. Agent Name is still required (blank), but is
// deliberately NOT roster-checked here the way Settlement/Top Up's
// checkAgentNameField checks theirs — Opening IS the flow that onboards a
// brand-new agent/shop in the first place, so "not found in the existing
// roster yet" is expected, not an error, on THIS import. checkAgentNameFormat
// below (Pattern A / Pattern B) is the only real business rule left on this
// field. Leader is free text, unvalidated. Opening Balance/SDP are both
// genuinely optional on both products — blank is a valid value (Cashout
// coerces it to 0 at display time, Send Money keeps it null) — so a blank
// cell is never an error, only a non-blank, non-numeric value is.
export type OpeningValidationConfig = {
  agentRoster: string[];
};

// Required-only — same message text as settlementValidation.ts's
// checkAgentNameField uses for a blank value ("Agent Name is required."),
// so issueLabel()'s own "missing" detection (a regex on that exact phrase)
// still resolves this to "Missing Agent Name" in the unified badge system.
// Deliberately does NOT roster-check (see header comment above).
export function checkAgentNameRequired(value: string): FieldCheckResult {
  if (!value.trim()) return { message: 'Agent Name is required.' };
  return null;
}

export function checkOptionalAmountField(value: string): FieldCheckResult {
  if (!value.trim()) return null;
  const numeric = parseAmount(value);
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '').trim());
  if (!looksNumeric || isNaN(numeric)) return { message: `"${value}" is not a valid number.` };
  return null;
}

// Opening is the source of truth for agent names — a new shop/agent must
// follow one of the accepted naming formats below. Independent of
// checkAgentNameRequired above (that only checks blank-vs-not, no longer
// roster-checked — see this file's header comment) — a row can fail one,
// both, or neither, and both are reported separately so the unified badge
// system shows both when applicable.
//
// These 5 patterns were derived directly from all 15,452 real agent_code
// values in the DB (not iterated example-by-example, after two earlier
// rounds of hardcoded-letter false positives) — together they cover
// 99.79% (15,419/15,452) of the real roster. The 33 real codes that still
// don't match are genuine data issues (wrong digit count, e.g. "AXERO05"/
// "ARCANE0100"), not a missed 6th format — confirmed by full enumeration,
// not sampling.
//
// Pattern A — short code: letters, exactly 3 digits, optional trailing
// letters (AVENT003UP, CYPHER014).
const AGENT_NAME_FORMAT_A = /^[A-Za-z]+\d{3}[A-Za-z]*$/;

// The 4 structured (dash-separated) shapes below all end the same way —
// <word><3 digits><optional 1 trailing letter>-<2 letters> — and all use a
// single hub-code letter, never hardcoded to a specific value: the earlier
// "B"/"J"-only Pattern B false-flagged 1,357 real codes, and the middle
// 2-letter connector (AG/BD/etc.) is generalized the same way here so a new
// connector value doesn't cause a 4th round of this same bug. Verified
// against all real data: neither the hub letter nor its digit is ever more
// than 1 character in the positions marked single below.
const BRAND_SUFFIX = '[A-Za-z]+\\d{3}[A-Za-z]?'; // e.g. AVENT001, SLEEP002A
const WALLET_SUFFIX = '[A-Za-z]{2}'; // BK/NG/RK/UP

// 5-segment: N-K1AG-J3-AVENT001-BK
const AGENT_NAME_FORMAT_B_5SEG = new RegExp(`^[A-Za-z]-[A-Za-z]\\d+[A-Za-z]{2}-[A-Za-z]\\d+-${BRAND_SUFFIX}-${WALLET_SUFFIX}$`);
// 4-segment (no middle hub-sub segment): T-B5AG-BURMA001-NG, D-M1BD-GOLD001-NG
const AGENT_NAME_FORMAT_B_4SEG = new RegExp(`^[A-Za-z]-[A-Za-z]\\d+[A-Za-z]{2}-${BRAND_SUFFIX}-${WALLET_SUFFIX}$`);
// PS-style (hub+connector+sub-digit fused, no dash between them): N-M1PS1-NASA027-RK
const AGENT_NAME_FORMAT_B_PS = new RegExp(`^[A-Za-z]-[A-Za-z]\\d[A-Za-z]{2}\\d-${BRAND_SUFFIX}-${WALLET_SUFFIX}$`);
// SH-style (literal "SH" hub, no hub digit): N-SHPS1-OMICRON007A-RK
const AGENT_NAME_FORMAT_B_SH = new RegExp(`^[A-Za-z]-SH[A-Za-z]{2}\\d-${BRAND_SUFFIX}-${WALLET_SUFFIX}$`, 'i');

const AGENT_NAME_PATTERNS = [
  AGENT_NAME_FORMAT_A,
  AGENT_NAME_FORMAT_B_5SEG,
  AGENT_NAME_FORMAT_B_4SEG,
  AGENT_NAME_FORMAT_B_PS,
  AGENT_NAME_FORMAT_B_SH,
];

export function checkAgentNameFormat(value: string): FieldCheckResult {
  if (!value.trim()) return null; // blank is already flagged as required elsewhere — not this check's concern
  if (AGENT_NAME_PATTERNS.some((pattern) => pattern.test(value))) return null;
  return { message: `"${value}" doesn't match any accepted Agent Name format.` };
}

function addIssue(entries: ValidationEntry[], row: OpeningImportRow, field: string, value: string, result: FieldCheckResult, type: ValidationEntry['type']) {
  if (!result) return;
  entries.push({ row: row.row, agent: row.agentName || '(blank)', field, value, issue: result.message, type });
}

export function validateOpeningRows(rows: OpeningImportRow[]): ValidationEntry[] {
  const entries: ValidationEntry[] = [];

  for (const row of rows) {
    addIssue(entries, row, 'Agent Name', row.agentName, checkAgentNameRequired(row.agentName), 'error');
    addIssue(entries, row, 'Agent Name Format', row.agentName, checkAgentNameFormat(row.agentName), 'error');
    addIssue(entries, row, 'Opening Balance', row.openingBalance, checkOptionalAmountField(row.openingBalance), 'error');
    addIssue(entries, row, 'SDP', row.sdp, checkOptionalAmountField(row.sdp), 'error');
  }

  return entries;
}
