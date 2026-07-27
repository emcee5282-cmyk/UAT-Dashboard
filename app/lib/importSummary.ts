import type { SettlementImportRow } from './xlsxParser';
import type { ValidationEntry } from './settlementValidation';
import { parseAmount } from './format';

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

export function calculateImportSummary(rows: SettlementImportRow[], entries: ValidationEntry[]): ImportSummary {
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
