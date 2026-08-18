import { NextResponse } from 'next/server';
import { getBrandsForProduct, type Product } from '@/app/lib/db/read/brands';

// Phase 10 — real brands list for the Settlement/Top Up upload wizard's
// client-side Brand validation (previously a hardcoded array). Server-side
// validation (importService.ts) queries the same table directly, not via
// this route — this exists only so the browser preview can match it.
export async function GET(request: Request) {
  try {
    const product = new URL(request.url).searchParams.get('product');
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }
    const brands = await getBrandsForProduct(product as Product);
    return NextResponse.json(brands, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch brands';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
