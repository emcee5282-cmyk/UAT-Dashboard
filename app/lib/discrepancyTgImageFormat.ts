import type { TgAccountStatus } from './discrepancyTgImageTypes';

// Formatting helpers for the Discrepancy TG image template — shared by the
// render page (app/internal/discrepancy-tg-image/page.tsx) and anything
// that builds the page-data payload fed into it.

// "13 Oct 2026 · 4:30 PM BD Time" — day with no leading zero, 12-hour
// time, explicit Asia/Dhaka conversion (never a hardcoded offset) so this
// is correct regardless of the server's own timezone (the VPS runs UTC).
// Only the suffix text is "BD Time" instead of "GMT+6" — the conversion
// itself, and every caller (Telegram outputs only, confirmed: no web page
// uses this), is unchanged.
export function formatBangladeshTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')} · ${get('hour')}:${get('minute')} ${get('dayPeriod')} BD Time`;
}

// Whole numbers, thousand separators — same convention as the Discrepancy
// Summary tab's own fmt(). Zero/blank is handled by the caller (greys it
// out), not here — this just formats whatever number it's given.
export function formatTgImageNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// The image/PDF header's own "Last update: {this}" value — a line's
// Balance tab last-upload instant, or an em dash when that line has never
// had one (per explicit instruction: continue rendering, don't block).
export function formatTgImageTimestamp(date: Date | null): string {
  return date ? formatBangladeshTimestamp(date) : '—';
}

// "Oct 14 | 03:16 PM BD Time" — the album caption's own date/time shape
// (section 5.1): short month, day without a leading zero, 2-digit hour,
// minutes, AM/PM. Deliberately its own Intl call rather than reformatting
// formatBangladeshTimestamp's string output — different field order and a
// zero-padded hour, not just a different separator.
export function formatBangladeshCaptionTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')} | ${get('hour')}:${get('minute')} ${get('dayPeriod')} BD Time`;
}

// Strips characters not allowed in file names on Windows/macOS/Linux —
// the leader name is free text (per Settings > Discrepancy TG, uppercased
// but otherwise unvalidated), so this is defensive, not just decorative.
export function sanitizeFilenamePart(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '').trim();
}

// The image's "Account Status" column — the Balance tab's Wallet Status
// collapsed to two values, per explicit instruction (never shows DP+WD /
// WD Only / etc.). walletStatus already reads "Disconnected" for a shop
// whose wallets aren't logged in (balanceService's login override); "No
// Record" means no wallet rows at all, so it can't be logged in either.
// Anything else is a logged-in wallet -> Active.
export function toTgAccountStatus(walletStatus: string): TgAccountStatus {
  return walletStatus === 'Disconnected' || walletStatus === 'No Record' ? 'Disconnected' : 'Active';
}
