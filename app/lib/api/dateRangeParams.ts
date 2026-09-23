// Shared ?from=&to= parsing for the 4 Settlement/Top Up GET routes — same
// validation everywhere rather than duplicated per file. Absent (both) is a
// valid "no range requested" state, not an error — the service layer
// defaults that to Effective Today, preserving pre-range-filter behavior.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateRangeParams(url: URL): { range?: { from: string; to: string }; error?: string } {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from && !to) return {};
  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return { error: '"from" and "to" must both be provided as YYYY-MM-DD.' };
  }
  if (from > to) return { error: '"from" must not be after "to".' };
  return { range: { from, to } };
}
