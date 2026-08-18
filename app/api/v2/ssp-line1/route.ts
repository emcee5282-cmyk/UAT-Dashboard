import { NextResponse } from 'next/server';
import { getSspLine1TopUpSettlement, type Product } from '@/app/lib/db/read/sspLine1';

// Phase 10 — SSP Line 1's Top Up/Settlement, PostgreSQL-backed via each
// transaction's own stored brand_id. Zero Google Sheets calls in this
// route. `cutoff` (YYYY-MM-DD) is supplied by the caller — the same
// business-day cutoff app/page.tsx already computes for its own other
// sections, reused here rather than re-derived server-side.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const product = url.searchParams.get('product');
    const cutoff = url.searchParams.get('cutoff');
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }
    if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      return NextResponse.json({ error: 'Missing or invalid cutoff (expected YYYY-MM-DD)' }, { status: 400 });
    }
    const rows = await getSspLine1TopUpSettlement(product as Product, cutoff);
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch SSP Line 1 data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
