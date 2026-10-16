import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { buildUnreconciledTgPreview } from '@/app/lib/server/unreconciledTgSendService';

// Admin-only. Returns the SAME plan the confirmation pop-up renders AND the
// actual send consumes — same contract as Discrepancy TG's own preview
// route. Never returns the token itself, only whether one is saved.
export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const preview = await buildUnreconciledTgPreview();
    return NextResponse.json(preview, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build send preview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
