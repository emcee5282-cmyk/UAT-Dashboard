import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';

// "Brand Balance" sheet: row 28 is a merged title ("BDT PG & BRAND
// SUMMARY"), skipped entirely. Row 29 is the header (Brand, SSP AG, SSP PS,
// ESS, AUTOPAY, EXPAY, Total Brand CIH), rows 30-39 are per-brand
// cash-in-hand totals, row 40 is the "Total PG CIH" column-totals footer.
export async function GET() {
  try {
    const rows = await fetchRange('Brand Balance!B29:H40');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
