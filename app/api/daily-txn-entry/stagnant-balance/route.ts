import { NextRequest, NextResponse } from 'next/server';
import { getStagnantBalanceRows } from '@/app/lib/services/stagnantBalanceService';

// Pending Balance's "Stagnant Balances" tab — raw (already 3+ day
// threshold-filtered) rows only; the group/sort/totals logic lives in
// app/lib/stagnantBalanceAggregate.ts (pure, client-side) so switching
// Cashout/Send Money/Group Total re-runs instantly with no refetch.
//
// `?force=1` bypasses balanceService.ts's own in-memory cache (the
// Pending Balance Refresh button's own one-shot signal).
export async function GET(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get('force') === '1';
    const { rows, recovered } = await getStagnantBalanceRows({ force });
    return NextResponse.json({ rows, recovered },{ headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Stagnant Balances';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
