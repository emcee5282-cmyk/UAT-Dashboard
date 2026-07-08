import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// Scoped to rows 3-8 (Cashout's own block) — a Send Money block (rows
// 11-16, see /api/sendmoney/sheet) lives further down this same tab, and an
// unscoped fetch would blend both products' wallet rows into one table.
// A blank row/column was added to the sheet ahead of this block (was
// A1:H6), shifting it to B3:I8 — same 8 columns, same relative order.
export async function GET() {
  try {
    const rows = await fetchRange('Dashboard Overview!B3:I8');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
