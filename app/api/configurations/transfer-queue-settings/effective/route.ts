import { NextResponse } from 'next/server';
import { readEffectiveTransferQueueRules } from '@/app/lib/transferQueueSettings';

// Used by the 3 LIVE Transfer Queue consumers (Cashout page, Send Money page, Sidebar
// badge counts) — distinct from the plain GET route above, which the Configuration
// admin page uses so an admin always sees/edits their real saved draft. This route
// resolves Production/Configuration mode server-side: in 'production' mode it returns
// the hardcoded defaults untouched, ignoring whatever's saved (the instant-rollback
// kill-switch); in 'configuration' mode it returns the actual saved rules
// (cache-backed, see transferQueueSettings.ts's 60s TTL).
export async function GET() {
  try {
    const rules = await readEffectiveTransferQueueRules();
    return NextResponse.json({ rules }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching effective Transfer Queue rules';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
