import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// Send Money's own wallet-level block lives in the SAME "Dashboard Overview"
// tab as Cashout's, rows 11-16 (header + BKASH/NAGAD/ROCKET/UPAY/Total) —
// confirmed with user. Scoped to this range so it never picks up Cashout's
// own block (rows 3-8) above it. A blank row/column was added ahead of this
// block (was A8:H13), shifting it to B11:I16 — same 8 columns, same order.
export async function GET() {
  try {
    const rows = await fetchRange('Dashboard Overview!B11:I16');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
