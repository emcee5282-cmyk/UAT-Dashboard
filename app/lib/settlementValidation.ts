import { excelSerialToDate, type SettlementImportRow } from './xlsxParser';
import { manilaFields, manilaMidnight } from './businessDate';
import { parseAmount } from './format';

// Validation Engine — deliberately separate from parsing/duplicate-
// detection/summary (see xlsxParser.ts, duplicateDetector.ts,
// importSummary.ts) so a new business rule (a new module's own required
// fields, a different date policy, etc.) only ever touches this file.
export type ValidationIssueType = 'error' | 'warning' | 'duplicate' | 'valid';

export type ValidationEntry = {
  row: number;
  agent: string;
  field: string;
  // The offending raw cell value — '' for a missing/required field, shown
  // as "(blank)" by the caller. Mirrors Opening Balance's own per-issue
  // "Invalid Value" column.
  value: string;
  // Full user-friendly message — no raw/technical wording.
  issue: string;
  type: ValidationIssueType;
};

export type ValidationConfig = {
  brandOptions: string[];
  walletOptions: string[]; // depends on the active Settlement tab (Cashout vs Send Money)
  agentRoster: string[]; // known agents — a miss here still blocks (see below)
  remarksSuggestions: string[]; // a miss here is a Warning, never an Error
};

// Accepts whatever shape the official template's Date column actually
// comes through as: a raw Excel serial number, this app's usual "M/D/YYYY"
// string convention, or any other generically Date-parseable string.
export function parseImportDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const serial = parseFloat(trimmed);
    if (serial > 20000 && serial < 90000) return excelSerialToDate(serial);
  }
  const slashParts = trimmed.split('/');
  if (slashParts.length === 3) {
    const [m, d, y] = slashParts.map(Number);
    if (m && d && y) return new Date(y, m - 1, d);
  }
  const generic = new Date(trimmed);
  return isNaN(generic.getTime()) ? null : generic;
}

// Always Asia/Manila (GMT+8), never the browser/runtime's own local
// timezone — a plain calendar-day "today", not the app's separate 2 AM
// business-day-rollover concept (app/lib/businessDate.ts's
// getBusinessToday()) used elsewhere for "is this row from today's sheet
// data" filtering; this is specifically about validating an *entered*
// date against the real calendar day in the business's own timezone.
export function getManilaCalendarToday(): Date {
  const { year, month, day } = manilaFields(new Date());
  return manilaMidnight(year, month, day);
}

// A single field's check result — null means valid. `details` is an
// enumerable "here are the allowed values" list (Brand/Wallet); shared by
// both the bulk row-by-row validator below AND the Edit Row modal's own
// live per-field validation (BulkImportModal wires these in directly via
// RecordFormModal's `getFieldHint` prop), so a business rule only ever
// needs to change here to apply everywhere at once.
export type FieldCheckResult = { message: string; details?: string[] } | null;

export function checkBrandField(value: string, config: Pick<ValidationConfig, 'brandOptions'>): FieldCheckResult {
  if (!value) return { message: 'Brand is required.' };
  if (!config.brandOptions.includes(value.toUpperCase())) {
    return { message: `Invalid Brand "${value}".`, details: config.brandOptions };
  }
  return null;
}

export function checkAgentNameField(value: string, config: Pick<ValidationConfig, 'agentRoster'>): FieldCheckResult {
  if (!value) return { message: 'Agent Name is required.' };
  if (!config.agentRoster.some((known) => known.toLowerCase() === value.toLowerCase())) {
    return { message: 'Agent not found in Balance Shop.' };
  }
  return null;
}

export function checkWalletField(value: string, config: Pick<ValidationConfig, 'walletOptions'>): FieldCheckResult {
  if (!value) return { message: 'Wallet is required.' };
  if (!config.walletOptions.some((option) => option.toLowerCase() === value.toLowerCase())) {
    return { message: `Wallet "${value}" is not supported.`, details: config.walletOptions };
  }
  return null;
}

export function checkAmountField(value: string): FieldCheckResult {
  if (!value) return { message: 'Amount is required.' };
  const numeric = parseAmount(value);
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '').trim());
  if (!looksNumeric || isNaN(numeric)) return { message: `"${value}" is not a valid number.` };
  if (numeric <= 0) return { message: 'Amount must be greater than zero.' };
  return null;
}

export function checkDateField(value: string): FieldCheckResult {
  if (!value) return { message: 'Date is required.' };
  const parsed = parseImportDate(value);
  if (!parsed) return { message: `"${value}" is not a valid date.` };
  if (parsed.getTime() > getManilaCalendarToday().getTime()) return { message: 'Future dates are not allowed.' };
  return null;
}

export function checkRemarksField(value: string, config: Pick<ValidationConfig, 'remarksSuggestions'>): FieldCheckResult {
  if (value && !config.remarksSuggestions.some((known) => known.toLowerCase() === value.toLowerCase())) {
    return { message: `Unrecognized remarks "${value}".` };
  }
  return null;
}

function addIssue(entries: ValidationEntry[], row: SettlementImportRow, field: string, value: string, result: FieldCheckResult, type: ValidationIssueType) {
  if (!result) return;
  entries.push({ row: row.row, agent: row.agentName || '(blank)', field, value, issue: result.message, type });
}

export function validateSettlementRows(rows: SettlementImportRow[], config: ValidationConfig): ValidationEntry[] {
  const entries: ValidationEntry[] = [];

  for (const row of rows) {
    addIssue(entries, row, 'Brand', row.brand, checkBrandField(row.brand, config), 'error');
    addIssue(entries, row, 'Agent Name', row.agentName, checkAgentNameField(row.agentName, config), 'error');
    addIssue(entries, row, 'Wallet', row.wallet, checkWalletField(row.wallet, config), 'error');
    addIssue(entries, row, 'Amount', row.amount, checkAmountField(row.amount), 'error');
    addIssue(entries, row, 'Date', row.date, checkDateField(row.date), 'error');
    addIssue(entries, row, 'Remarks', row.remarks, checkRemarksField(row.remarks, config), 'warning');
  }

  return entries;
}
