// Shared between the client-side upload-preview validation
// (app/summary/page.tsx, app/sendmoney/opening/page.tsx) and the
// server-side aggregation (app/lib/estimatedOpening.ts) so a row flagged
// invalid in the preview is treated identically — skipped, not silently
// defaulted to 0 — when the file is actually imported. Kept in its own
// module with no googleapis import so it's safe to import from client
// components (estimatedOpening.ts itself can't be, since the rest of that
// file pulls in the server-only Google Sheets write client).

export function isBlankOrDashCell(val: string | number | undefined | null): boolean {
  const cleaned = String(val ?? '').replace(/,/g, '').trim();
  return !cleaned || cleaned === '-';
}

// A cell counts as a valid number if it's blank/dash (treated as 0
// elsewhere, e.g. estimatedOpening.ts's own parseNumber) or parses as a
// full numeric string once commas are stripped. Deliberately stricter than
// a bare parseFloat(), which silently accepts "123abc" as 123 — this
// requires the ENTIRE cleaned string to be numeric, so garbage text gets
// caught instead of coerced.
export function isValidNumericCell(val: string | number | undefined | null): boolean {
  if (typeof val === 'number') return Number.isFinite(val);
  if (isBlankOrDashCell(val)) return true;
  const cleaned = String(val ?? '').replace(/,/g, '').trim();
  return cleaned !== '' && Number.isFinite(Number(cleaned));
}
