import { NextResponse } from 'next/server';
import { getBalanceLimitRows, getBalanceLimitLastImport } from '@/app/lib/db/read/balanceLimit';
import type { Product } from '@/app/lib/services/balanceLimitService';

// Phase 8B — Balance Limit's own read endpoint. Shared by both products
// (?product=cashout|sendmoney) since app/lib/db/read/balanceLimit.ts's
// getBalanceLimitRows() already takes a product param — one route instead
// of duplicating it per product. Reads PostgreSQL only, written by the
// Balance Limit upload pipeline (Phase 8/8A) — zero Google Sheets calls in
// this runtime path.
export async function GET(request: Request) {
  try {
    const product = new URL(request.url).searchParams.get('product');
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    const [rows, lastImport] = await Promise.all([
      getBalanceLimitRows(product as Product),
      getBalanceLimitLastImport(product as Product),
    ]);

    return NextResponse.json({ rows, lastImport }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch balance limit data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
