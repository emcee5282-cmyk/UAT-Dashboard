import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { buildDiscrepancyTgPreview } from '@/app/lib/server/discrepancyTgSendService';
import { getDiscrepancyTgData } from '@/app/lib/services/discrepancyTgService';

// Admin-only. Returns the SAME plan the confirmation pop-up renders AND
// the actual send consumes (buildSendPlan is the single source for both)
// — the preview can't drift from what's really sent. Never returns the
// token itself, only whether one is saved (the button's disabled state).
export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const [plan, tgData] = await Promise.all([buildDiscrepancyTgPreview(), getDiscrepancyTgData()]);
    return NextResponse.json(
      { leaders: plan.leaders, totalMessages: plan.totalMessages, thresholds: plan.thresholds, hasToken: Boolean(tgData.token) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build send preview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
