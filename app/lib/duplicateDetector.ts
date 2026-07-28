import type { ValidationEntry } from './settlementValidation';
import { parseAmount } from './format';

// Duplicate Detector — separate from the Validation Engine because "is this
// row shaped correctly" and "does this row collide with another" are
// different questions with different future data sources (the second one
// will eventually need a real database round-trip; the first never will).
//
// Generic over any import-row shape sharing these 5 fields (Settlement's
// `remarks`/Top Up's `type` never factor into the dedup signature, so both
// row types satisfy this constraint as-is — no per-module duplication).
type DedupRow = { row: number; brand: string; agentName: string; wallet: string; amount: string; date: string };
// Narrower shape than DedupRow — mockExistingRecordCheck's own logic never
// actually reads brand/wallet/amount/date, only row/agentName, so it's
// generic over any row carrying at least these two (Opening Balance rows
// included, which have neither brand nor wallet nor a transaction date).
type MockCheckRow = { row: number; agentName: string };

function rowKey(row: DedupRow): string {
  return [row.brand, row.agentName, row.wallet, parseAmount(row.amount), row.date]
    .map((part) => String(part).trim().toLowerCase())
    .join('|');
}

// Flags every occurrence AFTER the first in a group of identical rows — the
// first stays "clean" (it's the original; everything after it is what's
// actually duplicated), matching how a human reviewing the sheet would
// describe it.
export function detectDuplicatesWithinFile<T extends DedupRow>(rows: T[]): ValidationEntry[] {
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

// Opening Balance's own dedup signature — a roster snapshot has no brand/
// wallet/date to key off of; the same agent appearing twice in one uploaded
// file IS the duplicate, full stop (unlike Settlement/Top Up, where the
// same agent legitimately appears many times across different
// transactions).
export function detectDuplicateAgentNames<T extends MockCheckRow>(rows: T[]): ValidationEntry[] {
  const seen = new Map<string, number>();
  const entries: ValidationEntry[] = [];
  for (const row of rows) {
    const key = row.agentName.trim().toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      entries.push({ row: row.row, agent: row.agentName || '(blank)', field: 'Duplicate', value: '', issue: 'This agent already appears earlier in this file.', type: 'duplicate' });
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
export function mockExistingRecordCheck<T extends MockCheckRow>(rows: T[]): ValidationEntry[] {
  const entries: ValidationEntry[] = [];
  rows.forEach((row, i) => {
    if (i > 0 && (i + 1) % 7 === 0) {
      entries.push({ row: row.row, agent: row.agentName || '(blank)', field: 'Duplicate', value: '', issue: 'This record already exists in the system.', type: 'duplicate' });
    }
  });
  return entries;
}
