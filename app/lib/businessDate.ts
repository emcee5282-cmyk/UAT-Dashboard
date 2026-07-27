// The "business day" doesn't roll over at midnight — it rolls over at
// RESET_HOUR (2 AM), in the business's own timezone (Asia/Manila, UTC+8, no
// DST) — NOT the server runtime's timezone. Every function below computes
// via explicit Manila-offset math instead of native Date local-getters,
// because Vercel's serverless functions default to UTC: relying on local
// getters there silently rolled the business day over 8 hours + a calendar
// day late (confirmed — an upload made at ~2 AM Manila was logged as "6 PM
// the previous day" in the Estimated Opening Import Log, since the write
// path read the server's UTC hour/date instead of Manila's). Used
// everywhere "today" is derived — trend chart windows, CashGo/Bundle
// Transfer "Today" strips, Settlement/Top Up "today only" filters, the
// Estimated Opening upload's own validity gate — so they all agree on the
// same day boundary regardless of whether the code runs in a server
// function or a staff browser.
const RESET_HOUR = 2;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// Re-expresses an absolute instant so its own getUTC*() accessors read
// Manila's local wall-clock fields — works identically whether this runs
// in a Vercel/UTC server function or a browser set to any other timezone.
export function toManilaWallClock(date: Date): Date {
  return new Date(date.getTime() + MANILA_OFFSET_MS);
}

// Inverse of toManilaWallClock: given Manila wall-clock fields expressed as
// a Date.UTC(...) millisecond value, returns the true absolute instant.
export function fromManilaWallClockMs(manilaWallClockMs: number): Date {
  return new Date(manilaWallClockMs - MANILA_OFFSET_MS);
}

// True Manila midnight (as an absolute instant) of the given calendar date
// — matches what `new Date(year, month, day)` already produces on a
// machine whose OS clock is set to Asia/Manila (true for staff's own
// browsers), so date-only comparisons elsewhere in the app that assume a
// Manila-set client clock stay correct against this. Exported so callers
// that need to build a Manila-anchored date from a plain Y/M/D (e.g. a
// sheet's own "M/D/YYYY" transaction date, see estimatedOpening.ts's
// parseStlmRowDate) can compare it against getBusinessToday()/
// parseCardCutoffDate's own output on equal footing — a native
// `new Date(y, m, d)` is anchored to the runtime's OWN timezone instead,
// silently off by 8 hours from every Manila-anchored date in this module.
export function manilaMidnight(year: number, month: number, day: number): Date {
  return fromManilaWallClockMs(Date.UTC(year, month, day));
}

// Exported so callers that need "the current Manila calendar year" (e.g. a
// sheet card date with no year printed on it) don't fall back to a native
// `new Date().getFullYear()` — that reads the RUNTIME's own local year,
// which silently differs from Manila's right around New Year's, and — more
// commonly hit in practice — differs from Manila's own *day* boundary
// year-round whenever the runtime's local timezone isn't Asia/Manila (e.g.
// a headless-Chromium capture tool defaulting to UTC).
export function manilaFields(date: Date): { year: number; month: number; day: number } {
  const wallClock = toManilaWallClock(date);
  return { year: wallClock.getUTCFullYear(), month: wallClock.getUTCMonth(), day: wallClock.getUTCDate() };
}

// Midnight (Manila time) of the business date a given moment falls into,
// per the rule above. Exposed generically (not just for "now") so a
// timestamp read from data — e.g. the "Estimated Opening" upload's own
// "Last Updated" card — can be checked against the same day boundary.
export function toBusinessDate(date: Date): Date {
  const { year, month, day } = manilaFields(new Date(date.getTime() - RESET_HOUR * 60 * 60 * 1000));
  return manilaMidnight(year, month, day);
}

// Midnight (Manila time) of the current business date.
export function getBusinessToday(): Date {
  return toBusinessDate(new Date());
}

// Parses a sheet "Updated Time" card like "July 15 - 8:25 AM" (month name +
// day, no year — Cashout's own col G, Send Money's own col I) into a
// business-date-comparable Date, using the SAME Manila-midnight convention
// as getBusinessToday()/toBusinessDate() so the two can't drift apart
// across a server/client boundary. The year isn't printed on the card
// itself — inferred from the current Manila business year (not the
// runtime's own clock) so a card read right around New Year's doesn't
// silently parse into the wrong year.
export function parseCardCutoffDate(cell: string): Date | null {
  const match = cell.trim().match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*\d{1,2}:\d{2}\s*[AP]M$/i);
  if (!match) return null;
  const [, monthName, day] = match;
  // Dummy year only to extract month/day via the runtime's own Date
  // parser — safe because it's read back in the same runtime that parsed
  // it (a self-consistent round trip regardless of which timezone that is).
  const monthDay = new Date(`${monthName} ${day}, 2000`);
  if (isNaN(monthDay.getTime())) return null;
  const { year } = manilaFields(new Date());
  return manilaMidnight(year, monthDay.getMonth(), monthDay.getDate());
}

// A sheet transaction date formatted "M/D/YYYY" (Settlement/Top Up rows) —
// true only for the current business date (see getBusinessToday() above),
// not the literal calendar day. Confirmed byte-identical across app/stlm,
// app/sendmoney/settlement, app/topup and app/sendmoney/topup before
// extraction.
// Wall-clock "11:32 AM (GMT+8)" display — Manila's clock face, not just its
// day boundary (the rest of this file's concern). Uses Intl's own timeZone
// support directly rather than the toManilaWallClock()/getUTC* trick above,
// since that trick only re-exposes date FIELDS (Y/M/D) through UTC
// accessors — it doesn't give back a correctly zoned hour/minute string on
// its own, and Intl already solves that exactly.
export function formatManilaClockTime(date: Date): string {
  const time = date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${time} (GMT+8)`;
}

export function isToday(dateStr: string): boolean {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return false;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return false;
  const now = getBusinessToday();
  return m === now.getMonth() + 1 && d === now.getDate() && y === now.getFullYear();
}

// Same "M/D/YYYY" sheet-date check as isToday(), one business day earlier —
// used by Settlement's KPI summary row to compute a real "vs yesterday"
// comparison from the same sheet (which carries several weeks of rows, not
// just today's — isToday()/this function are what narrow it down, not a
// separate fetch). Mirrors isToday()'s exact field-extraction convention
// (`.getMonth()`/`.getDate()`/`.getFullYear()` on the business-date instant,
// not manilaFields()) so the two stay consistent with each other on any
// client, not just ones set to Asia/Manila.
export function isYesterday(dateStr: string): boolean {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return false;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return false;
  const yesterday = new Date(getBusinessToday().getTime() - 24 * 60 * 60 * 1000);
  return m === yesterday.getMonth() + 1 && d === yesterday.getDate() && y === yesterday.getFullYear();
}
