import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// "Brand Balance" sheet, Send Money's own "SSP Line 1" table: same shape as
// Cashout's (Brand, Opening Balance, Deposit, Withdrawal, Adjustment,
// Total), just a different range on the same tab — confirmed from the user
// directly (B16:G26).
export async function GET() {
  try {
    const rows = await fetchRange('Brand Balance!B16:G26');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
