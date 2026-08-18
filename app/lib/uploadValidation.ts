// Shared between the client-side upload-preview validation
// (app/summary/page.tsx, app/sendmoney/opening/page.tsx) and the
// server-side aggregation (app/lib/estimatedOpening.ts) so a row flagged
// invalid in the preview is treated identically — skipped, not silently
// defaulted to 0 — when the file is actually imported. Kept in its own
// module with no googleapis import so it's safe to import from client
// components (estimatedOpening.ts itself can't be, since the rest of that
// file pulls in the server-only Google Sheets write client).

// A leading apostrophe is Excel's own "force this cell to text" convention.
// When a REAL Excel quote-prefix cell (user typed '- directly into Excel)
// round-trips through this app's own xlsx read/write, the apostrophe is
// just a UI hint — never part of the stored value, so it already reads back
// as a plain "-" (confirmed directly against the `xlsx` package). But some
// export tools (Payment's raw Balance Limit export among them) instead
// write the apostrophe as a literal character INTO the cell's own string
// content, so it survives into the parsed value as-is (confirmed: comes
// through as the 2-character string "'-", not "-") — that's what was
// wrongly failing numeric validation.
//
// Deliberately only stripped here, for the blank/dash check — NOT inside
// isValidNumericCell's own general numeric-parse branch below. Every
// downstream numeric coercion (balanceLimitService.ts's n(), estimated
// Opening.ts's parseNumber()) uses a bare parseFloat() that does NOT strip
// a leading apostrophe, so an apostrophe-prefixed REAL number (e.g. "'1234")
// would pass validation here but silently parse to 0 downstream — worse
// than today's explicit error. Keeping the general numeric branch
// unstripped means that case still correctly fails validation instead of
// silently corrupting the imported value; only the known blank/dash
// placeholder pattern is special-cased.
function stripQuotePrefix(cleaned: string): string {
  return cleaned.startsWith("'") ? cleaned.slice(1) : cleaned;
}

export function isBlankOrDashCell(val: string | number | undefined | null): boolean {
  const cleaned = stripQuotePrefix(String(val ?? '').replace(/,/g, '').trim());
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
