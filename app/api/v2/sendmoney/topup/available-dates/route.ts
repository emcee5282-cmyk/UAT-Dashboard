import { NextResponse } from 'next/server';
import { getAvailableTransactionDates } from '@/app/lib/services/transactionPageService';

// Distinct Manila dates with Top Up rows — powers the date-range popover's
// calendar/Quick Select disabled states.
export async function GET() {
  try {
    const dates = await getAvailableTransactionDates('sendmoney', 'topup');
    return NextResponse.json({ dates }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load available dates';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
