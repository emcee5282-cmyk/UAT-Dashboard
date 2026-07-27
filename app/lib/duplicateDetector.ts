import type { SettlementImportRow } from './xlsxParser';
import type { ValidationEntry } from './settlementValidation';
import { parseAmount } from './format';

// Duplicate Detector — separate from the Validation Engine because "is this
// row shaped correctly" and "does this row collide with another" are
// different questions with different future data sources (the second one
// will eventually need a real database round-trip; the first never will).
function rowKey(row: SettlementImportRow): string {
  return [row.brand, row.agentName, row.wallet, parseAmount(row.amount), row.date]
    .map((part) => String(part).trim().toLowerCase())
    .join('|');
}

// Flags every occurrence AFTER the first in a group of identical rows — the
// first stays "clean" (it's the original; everything after it is what's
// actually duplicated), matching how a human reviewing the sheet would
// describe it.
export function detectDuplicatesWithinFile(rows: SettlementImportRow[]): ValidationEntry[] {
  const seen = new Map<string, number>();
  const entries: ValidationEntry[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      entries.push({ row: row.row, agent: row.agentName || '(blank)', field: 'Duplicate', value: '', issue: 'Duplicate transaction detected.', type: 'duplicate' });
    }
  }
  return entries;
}

// Prototype-phase stand-in for a real "does this settlement already exist"
// database check (per spec: "For now this can be mocked. Do NOT implement
// backend yet."). Deterministic (not Math.random()) so the same file
// produces the same result on every scan instead of flickering between
// re-renders — every 7th row is flagged, purely to populate the UI with a
// representative example of what a real match would look like.
export function mockExistingRecordCheck(rows: SettlementImportRow[]): ValidationEntry[] {
  const entries: ValidationEntry[] = [];
  rows.forEach((row, i) => {
    if (i > 0 && (i + 1) % 7 === 0) {
      entries.push({ row: row.row, agent: row.agentName || '(blank)', field: 'Duplicate', value: '', issue: 'This record already exists in the system.', type: 'duplicate' });
    }
  });
  return entries;
}
