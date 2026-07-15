import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// "Brand Balance" sheet, "SSP Line 1 Agent CashOut" table: row 0 is the
// header (Brand, Opening Balance, Deposit, Withdrawal, Adjustment, Total),
// rows 1-10 are one row per brand (M1/M2/K1/B1-B5/T1/J1) — no footer row,
// confirmed range from the user directly (B3:G13).
export async function GET() {
  try {
    const rows = await fetchRange('Brand Balance!B3:G13');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
