import type { OpeningImportRow } from './xlsxParser';
import { checkAgentNameField, type ValidationEntry, type FieldCheckResult } from './settlementValidation';
import { parseAmount } from './format';

// Modeled on settlementValidation.ts's validateSettlementRows, but Opening
// Balance's row shape has no Brand/Wallet/Date/Type at all — a static
// roster snapshot (Agent Name/Leader/Opening Balance/Security Deposit), not
// a per-transaction record. Only Agent Name is a hard requirement (roster-
// checked, same as Settlement/Top Up); Leader is free text, unvalidated.
// Opening Balance/SDP are both genuinely optional on both products — blank
// is a valid value (Cashout coerces it to 0 at display time, Send Money
// keeps it null) — so a blank cell is never an error, only a non-blank,
// non-numeric value is.
export type OpeningValidationConfig = {
  agentRoster: string[];
};

export function checkOptionalAmountField(value: string): FieldCheckResult {
  if (!value.trim()) return null;
  const numeric = parseAmount(value);
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '').trim());
  if (!looksNumeric || isNaN(numeric)) return { message: `"${value}" is not a valid number.` };
  return null;
}

function addIssue(entries: ValidationEntry[], row: OpeningImportRow, field: string, value: string, result: FieldCheckResult, type: ValidationEntry['type']) {
  if (!result) return;
  entries.push({ row: row.row, agent: row.agentName || '(blank)', field, value, issue: result.message, type });
}

export function validateOpeningRows(rows: OpeningImportRow[], config: OpeningValidationConfig): ValidationEntry[] {
  const entries: ValidationEntry[] = [];

  for (const row of rows) {
    addIssue(entries, row, 'Agent Name', row.agentName, checkAgentNameField(row.agentName, config), 'error');
    addIssue(entries, row, 'Opening Balance', row.openingBalance, checkOptionalAmountField(row.openingBalance), 'error');
    addIssue(entries, row, 'SDP', row.sdp, checkOptionalAmountField(row.sdp), 'error');
  }

  return entries;
}
