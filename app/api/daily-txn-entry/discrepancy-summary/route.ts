import { NextRequest, NextResponse } from 'next/server';
import { getDiscrepancySummaryRows } from '@/app/lib/services/discrepancySummaryService';

// Daily Txn Entry's "Discrepancy Summary" tab — always live, same source as
// the Balance tab (no snapshot, no date picker, no separate table). Raw rows
// only; the filter/group/sort/totals logic lives in
// app/lib/discrepancySummaryAggregate.ts (pure, client-side) so it can be
// unit-tested and re-run instantly when switching the Cashout/Send Money/
// Group Total card with no refetch.
//
// `?force=1` bypasses balanceService.ts's own in-memory cache (the
// Pending Balance Refresh button's own one-shot signal) — see that file's
// own comment for why the cache exists and how it's keyed.
export async function GET(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get('force') === '1';
    const rows = await getDiscrepancySummaryRows({ force });
    return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Discrepancy Summary';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
