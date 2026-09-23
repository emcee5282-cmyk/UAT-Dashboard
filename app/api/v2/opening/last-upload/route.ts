import { NextResponse } from 'next/server';
import { getLatestOpeningImportCutoff } from '@/app/lib/services/balanceService';

// Opening page's own header "Last update" indicator — the same
// import_batches signal balanceService.ts's Estimated Opening override
// already keys off internally, just surfaced here too. A separate,
// additive endpoint rather than folding this into GET /api/v2/opening's
// own response, since that route's bare-array shape is already consumed
// by several other pages (stlm, topup, wallet-status(-demo)) that would
// all need updating for no reason if its shape changed.
export async function GET() {
  try {
    const lastOpeningUpload = await getLatestOpeningImportCutoff('cashout');
    return NextResponse.json({ lastOpeningUpload }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load last Opening upload';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
