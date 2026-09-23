import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { getDailyTxnCashgoForDate, getDailyTxnCashgoHistory } from '@/app/lib/db/read/dailyTxnCashgo';
import { upsertCashgoEntry } from '@/app/lib/services/dailyTxnEntryService';
import { getEffectiveBusinessToday } from '@/app/lib/services/balanceService';

// Serves both the Operations tab's CashGoHourlyCard ("today", the default)
// and the CashGo tab's CashGoDailyTargetCard (?history=1 — last 2 months,
// grouped into one entry per day). businessDate is always computed
// server-side via getBusinessToday(), never trusted from the client.

function todayStr(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "YYYY-MM-DD" -> "September 12" — built from the string's own components
// (never via `new Date(dateStr)`, which parses as UTC midnight and can
// shift the displayed day by one depending on the reader's timezone).
function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const today = todayStr();

  if (url.searchParams.get('history') === '1') {
    // 2-month window, same as the retention cutoff, so the read never shows
    // more than what's actually kept.
    const sinceDate = addDays(today, -60);
    const rows = await getDailyTxnCashgoHistory(sinceDate);

    const byDate = new Map<string, { channel: 'bkash' | 'nagad'; target: number | null; process: number | null }[]>();
    for (const r of rows) {
      const arr = byDate.get(r.businessDate) ?? [];
      arr.push({ channel: r.channel, target: r.target, process: r.process });
      byDate.set(r.businessDate, arr);
    }
    const days = Array.from(byDate.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([isoDate, wallets]) => ({ isoDate, date: formatDateLabel(isoDate), today: isoDate === today, wallets }));

    // "Today" for the month-to-date chip — gated on Estimated Opening
    // actually existing for the day, not raw wall-clock (see
    // getEffectiveBusinessToday's own header comment). CashGo has no Send
    // Money equivalent, so this is always resolved for 'cashout'.
    const effectiveToday = await getEffectiveBusinessToday('cashout');

    return NextResponse.json({ days, effectiveToday });
  }

  const allRows = await getDailyTxnCashgoForDate(today);
  const rows = allRows.map((r) => ({ channel: r.channel, target: r.target, process: r.process }));
  const entered = allRows.filter((r) => r.target !== null || r.process !== null);
  const lastUpdate = entered.length > 0 ? new Date(Math.max(...entered.map((r) => r.updatedAt.getTime()))).toISOString() : null;

  return NextResponse.json({ businessDate: today, rows, lastUpdate });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const channel = body?.channel;
  if (channel !== 'bkash' && channel !== 'nagad') {
    return NextResponse.json({ error: 'Expected { channel: "bkash" | "nagad", target, process }' }, { status: 400 });
  }

  const businessDate = todayStr();
  await upsertCashgoEntry({
    businessDate,
    channel,
    target: body.target === undefined ? null : body.target,
    process: body.process === undefined ? null : body.process,
  });

  return NextResponse.json({ ok: true, businessDate });
}
