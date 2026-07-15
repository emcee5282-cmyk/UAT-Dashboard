// The "business day" doesn't roll over at midnight — it rolls over at
// RESET_HOUR (2 AM). E.g. at 12:38 AM the effective business date is still
// yesterday; only once the clock hits 2:00 AM does "today" advance to the
// new calendar day. Used everywhere "today" is derived from the system
// clock (trend chart windows, CashGo/Bundle Transfer "Today" strips,
// Settlement/Top Up "today only" filters) so they all agree on the same
// day boundary.
const RESET_HOUR = 2;

// Midnight (time zeroed) of the business date a given moment falls into,
// per the rule above. Exposed generically (not just for "now") so a
// timestamp read from data — e.g. the "Estimated Opening" upload's own
// "Last Updated" card — can be checked against the same day boundary.
export function toBusinessDate(date: Date): Date {
  const shifted = new Date(date.getTime() - RESET_HOUR * 60 * 60 * 1000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

// Midnight (time zeroed) of the current business date.
export function getBusinessToday(): Date {
  return toBusinessDate(new Date());
}
