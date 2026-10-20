// "Last active" date -> short label, for the Discrepancy TG image's
// Account Status subline (and anything else that wants the same wording).
// Pure, no I/O — `todayBd` is passed in so callers can share one value
// across a run and so this stays testable.
//
// "Last active" here means the last business day the shop had a non-zero
// Withdrawal, derived from stagnant_balance_tracking (per explicit
// confirmation — no real login-history table exists).

export type LastActiveTone = 'muted' | 'amber' | 'red';
export type LastActiveLabel = { text: string; tone: LastActiveTone };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseYmd(s: string): { y: number; m: number; d: number; ms: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, ms: Date.UTC(y, m - 1, d) };
}

function toYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' for "today" in Bangladesh (Asia/Dhaka) — never the server's
// own clock date (the VPS runs UTC).
export function bdTodayYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// stagnant_balance_tracking stores "N days without WD as of
// lastCheckedCutoffDate" — so the last WD day is that date minus N. No row
// at all (null) means no record -> "Never".
export function deriveLastActiveDate(lastCheckedCutoffDate: string | null, noDataStreakDays: number | null): string | null {
  if (!lastCheckedCutoffDate) return null;
  const { ms } = parseYmd(lastCheckedCutoffDate);
  return toYmd(ms - (noDataStreakDays ?? 0) * 86_400_000);
}

export function formatLastActiveLabel(lastActiveYmd: string | null, todayBdYmd: string): LastActiveLabel {
  if (!lastActiveYmd) return { text: 'Never', tone: 'muted' };

  const last = parseYmd(lastActiveYmd);
  const today = parseYmd(todayBdYmd);
  const daysAgo = Math.round((today.ms - last.ms) / 86_400_000);

  // A future date (e.g. a Manila business date already rolled over before
  // Dhaka's) still reads as today rather than a negative "days ago".
  if (daysAgo <= 0) return { text: 'Today', tone: 'muted' };
  if (daysAgo === 1) return { text: 'Yesterday', tone: 'amber' };

  const dayMonth = `${last.d} ${MONTHS[last.m - 1]}`;
  if (last.y !== today.y) return { text: `${dayMonth} ${last.y}`, tone: 'red' };
  if (daysAgo <= 6) return { text: `${WEEKDAYS[new Date(last.ms).getUTCDay()]}, ${dayMonth}`, tone: 'red' };
  return { text: dayMonth, tone: 'red' };
}
