import type { ValidationEntry } from './settlementValidation';
import { parseAmount } from './format';

// Generic over any import-row shape carrying these 4 fields — both
// SettlementImportRow and TopUpImportRow satisfy this as-is, so the summary
// math is written once instead of duplicated per module.
type SummaryRow = { row: number; brand: string; wallet: string; amount: string };

export type ImportSummary = {
  totalRows: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  duplicateCount: number;
  totalAmount: number;
  brandCount: number;
  walletTypeCount: number;
};

// A row can carry several issues of different types at once — its OWN
// single-bucket classification for the top-line counters follows a fixed
// priority: any error makes the whole row an error row (even if it also
// has warnings), otherwise any duplicate flag makes it a duplicate row,
// otherwise any warning makes it a warning row, otherwise it's clean.
export function classifyRow(rowNumber: number, entries: ValidationEntry[]): ValidationEntry['type'] {
  const rowEntries = entries.filter((entry) => entry.row === rowNumber);
  if (rowEntries.some((entry) => entry.type === 'error')) return 'error';
  if (rowEntries.some((entry) => entry.type === 'duplicate')) return 'duplicate';
  if (rowEntries.some((entry) => entry.type === 'warning')) return 'warning';
  return 'valid';
}

export function calculateImportSummary<T extends SummaryRow>(rows: T[], entries: ValidationEntry[]): ImportSummary {
  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  let totalAmount = 0;
  const brands = new Set<string>();
  const wallets = new Set<string>();

  for (const row of rows) {
    const bucket = classifyRow(row.row, entries);
    if (bucket === 'error') errorCount += 1;
    else if (bucket === 'duplicate') duplicateCount += 1;
    else if (bucket === 'warning') warningCount += 1;
    else validCount += 1;

    if (bucket !== 'error') totalAmount += parseAmount(row.amount);
    if (row.brand) brands.add(row.brand.toUpperCase());
    if (row.wallet) wallets.add(row.wallet.toLowerCase());
  }

  return {
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    duplicateCount,
    totalAmount,
    brandCount: brands.size,
    walletTypeCount: wallets.size,
  };
}

// Opening Balance has no brand/wallet — a separate calculator rather than
// forcing calculateImportSummary's SummaryRow shape wider, since
// brandCount/walletTypeCount would be meaningless here and the wizard's own
// stat cards never render them anyway (only Total Records/Ready/Total
// Amount/Errors are shown). Blank Opening Balance is treated as 0 for this
// running total only — display/summary purposes, not a change to the
// page's own null-vs-0 data model.
type OpeningSummaryRow = { row: number; openingBalance: string };

export function calculateOpeningImportSummary<T extends OpeningSummaryRow>(rows: T[], entries: ValidationEntry[]): ImportSummary {
  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  let totalAmount = 0;

  for (const row of rows) {
    const bucket = classifyRow(row.row, entries);
    if (bucket === 'error') errorCount += 1;
    else if (bucket === 'duplicate') duplicateCount += 1;
    else if (bucket === 'warning') warningCount += 1;
    else validCount += 1;

    if (bucket !== 'error') totalAmount += parseAmount(row.openingBalance);
  }

  return {
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    duplicateCount,
    totalAmount,
    brandCount: 0,
    walletTypeCount: 0,
  };
}
