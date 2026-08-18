import type { ValidationEntry } from './settlementValidation';
import { parseAmount } from './format';
// Type-only — erased at compile time, so this never pulls
// transactionPageService.ts's actual server-only code (getDb/drizzle) into
// the client bundle. Just borrows its shape for the existing-records
// signature this file compares against.
import type { ExistingTransactionSignature } from './services/transactionPageService';

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

// Round 3 — mockExistingRecordCheck() used to live here: a positional
// "every 7th row" stand-in for a real cross-upload "does this already
// exist in the DB" check (explicitly documented from the start as a
// prototype-phase placeholder, "do NOT implement backend yet"). Removed —
// since it flagged by array INDEX alone, never by field values, editing a
// row's data could never clear it if that row's position happened to land
// on a multiple of 7, so a row genuinely made unique still showed as
// "Duplicate" forever (see BulkImportModal.tsx's runValidation for the
// full explanation).
//
// This is the REAL replacement: a genuine live check against
// wallet_transactions, via getTransactionSignaturesForDates
// (transactionPageService.ts) — fetched once per scan (BulkImportModal.tsx's
// scanning step), bounded to the exact dates present in the file, then
// compared here in memory. The 6-field signature (Brand+Agent+Amount+
// Wallet+Type/Remarks+Date) matches duplicateClusters' own in-file
// clustering signature exactly, so a row is judged "duplicate" the same
// way regardless of which of the two sources it matched.
function existingRecordSignatureKey(brand: string | null | undefined, agent: string, wallet: string | null | undefined, amount: string, sixth: string | null | undefined, dateKey: string): string {
  return [brand, agent, wallet, parseAmount(amount), sixth, dateKey]
    .map((part) => String(part ?? '').trim().toLowerCase())
    .join('|');
}

// Generic over any row shape carrying these base fields — the 6th field
// (Settlement's Remarks vs Top Up's Type) and the row's own date, both
// normalized to a comparable form, are supplied via callbacks rather than
// assumed field names, since the caller's ImportRow shape varies by module
// and its raw date string needs parsing before it's comparable to the DB's
// 'YYYY-MM-DD' storage — this file has no date-parsing logic of its own and
// isn't taking on that dependency just for this.
type AlreadyImportedRow = { row: number; brand: string; agentName: string; wallet: string; amount: string };

export function detectAlreadyImportedDuplicates<T extends AlreadyImportedRow>(
  rows: T[],
  existingRecords: ExistingTransactionSignature[],
  getSixthField: (row: T) => string,
  getDateKey: (row: T) => string | null // 'YYYY-MM-DD', or null for an unparseable date (already flagged elsewhere — checkDateField — so just skipped here)
): { entries: ValidationEntry[]; matchByRow: Map<number, ExistingTransactionSignature> } {
  // Keyed so the FIRST/earliest existing record for a given signature wins
  // — a row matching several existing records still only ever reports one.
  const existingBySignature = new Map<string, ExistingTransactionSignature>();
  existingRecords.forEach((record) => {
    const key = existingRecordSignatureKey(record.brandCode, record.agentCode, record.wallet, record.amount, record.remarks, record.occurredOn);
    if (!existingBySignature.has(key)) existingBySignature.set(key, record);
  });

  const entries: ValidationEntry[] = [];
  const matchByRow = new Map<number, ExistingTransactionSignature>();
  for (const row of rows) {
    const dateKey = getDateKey(row);
    if (!dateKey) continue;
    const key = existingRecordSignatureKey(row.brand, row.agentName, row.wallet, row.amount, getSixthField(row), dateKey);
    const match = existingBySignature.get(key);
    if (match) {
      entries.push({ row: row.row, agent: row.agentName || '(blank)', field: 'Duplicate', value: '', issue: 'This record was already imported.', type: 'duplicate' });
      matchByRow.set(row.row, match);
    }
  }
  return { entries, matchByRow };
}
