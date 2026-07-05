import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// Send Money's own wallet-level block lives in the SAME "Dashboard Overview"
// tab as Cashout's, rows 8-13 (header + BKASH/NAGAD/ROCKET/UPAY/Total) —
// confirmed with user. Scoped to this range so it never picks up Cashout's
// own block (rows 1-6) above it.
export async function GET() {
  try {
    const rows = await fetchRange('Dashboard Overview!A8:H13');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
