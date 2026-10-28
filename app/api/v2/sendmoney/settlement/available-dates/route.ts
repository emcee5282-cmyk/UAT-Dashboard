import { NextResponse } from 'next/server';
import { getAvailableTransactionDates } from '@/app/lib/services/transactionPageService';
import { authorizeApi } from '@/app/lib/auth/guard';

// Distinct Manila dates with Settlement rows — powers the date-range
// popover's calendar/Quick Select disabled states.
export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const dates = await getAvailableTransactionDates('sendmoney', 'settlement');
    return NextResponse.json({ dates }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load available dates';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
