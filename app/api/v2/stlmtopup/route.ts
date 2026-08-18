import { NextResponse } from 'next/server';
import { getTopUpSettlementTotals } from '@/app/lib/services/balanceService';

// Balance page's Settlement/Top Up migration — reads PostgreSQL only
// (wallet_transactions, via the Settlement/Top Up bulk-import wizards),
// zero Google Sheets calls in this runtime path. Deliberately independent
// of /api/v2/balance-limit and Opening's own sourcing — this page's
// Company Balance/Balance Inside/Group columns keep reading whatever they
// already read; only the Settlement/Top Up slice moves here.
export async function GET(request: Request) {
  try {
    const product = new URL(request.url).searchParams.get('product');
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    const totals = await getTopUpSettlementTotals(product);
    return NextResponse.json(
      { totals: Object.fromEntries(totals) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch Settlement/Top Up totals';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
