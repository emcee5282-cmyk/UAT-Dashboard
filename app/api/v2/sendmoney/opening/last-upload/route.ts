import { NextResponse } from 'next/server';
import { getLatestOpeningImportCutoff } from '@/app/lib/services/balanceService';

// Send Money Opening page's own header "Last update" indicator — sibling of
// /api/v2/opening/last-upload (Cashout), same reasoning: a separate,
// additive endpoint rather than folding this into GET /api/v2/sendmoney/opening's
// own bare-array response, which other pages also consume unchanged.
export async function GET() {
  try {
    const lastOpeningUpload = await getLatestOpeningImportCutoff('sendmoney');
    return NextResponse.json({ lastOpeningUpload }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load last Opening upload';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
