import type { TopUpImportRow } from './xlsxParser';
import {
  checkBrandField,
  checkAgentNameField,
  checkWalletField,
  checkAmountField,
  checkDateField,
  type ValidationEntry,
  type FieldCheckResult,
} from './settlementValidation';

// Modeled on settlementValidation.ts's validateSettlementRows — same
// engine, same field-checker functions reused for Brand/Agent Name/Wallet/
// Amount/Date. Only Type differs: Settlement's Remarks is free text (a
// mismatch is a soft warning via checkRemarksField), but Top Up's Type is a
// closed set (see TOPUP_TYPE_OPTIONS, shared by both products) — a mismatch
// here is a hard error, like Wallet/Brand, not a warning.
export type TopUpValidationConfig = {
  brandOptions: string[];
  walletOptions: string[];
  agentRoster: string[];
  typeOptions: string[];
};

export function checkTypeField(value: string, config: Pick<TopUpValidationConfig, 'typeOptions'>): FieldCheckResult {
  if (!value) return { message: 'Type is required.' };
  if (!config.typeOptions.some((option) => option.toLowerCase() === value.toLowerCase())) {
    return { message: `Type "${value}" is not supported.`, details: config.typeOptions };
  }
  return null;
}

function addIssue(entries: ValidationEntry[], row: TopUpImportRow, field: string, value: string, result: FieldCheckResult, type: ValidationEntry['type']) {
  if (!result) return;
  entries.push({ row: row.row, agent: row.agentName || '(blank)', field, value, issue: result.message, type });
}

export function validateTopUpRows(rows: TopUpImportRow[], config: TopUpValidationConfig): ValidationEntry[] {
  const entries: ValidationEntry[] = [];

  for (const row of rows) {
    addIssue(entries, row, 'Brand', row.brand, checkBrandField(row.brand, config), 'error');
    addIssue(entries, row, 'Agent Name', row.agentName, checkAgentNameField(row.agentName, config), 'error');
    addIssue(entries, row, 'Wallet', row.wallet, checkWalletField(row.wallet, config), 'error');
    addIssue(entries, row, 'Amount', row.amount, checkAmountField(row.amount), 'error');
    addIssue(entries, row, 'Date', row.date, checkDateField(row.date), 'error');
    addIssue(entries, row, 'Type', row.type, checkTypeField(row.type, config), 'error');
  }

  return entries;
}
