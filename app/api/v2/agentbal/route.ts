import { NextResponse } from 'next/server';
import { getAgentBalancesForBalancePage } from '@/app/lib/services/balanceService';
import { getBalanceLimitLastImport } from '@/app/lib/db/read/balanceLimit';

// Postgres-backed equivalent of /api/agentbal + client-side balanceEngine.ts
// calculations, all now computed server-side. Used by app/agentbal/page.tsx
// when NEXT_PUBLIC_AGENTBAL_SOURCE=postgres (isPostgresSourceEnabled()) —
// /api/agentbal (Sheets-based) stays the default otherwise.
// Response wrapped as { rows, lastImport } (not a bare array) — matches
// /api/v2/balance-limit's own shape, and lets the header's "Updated {time}"
// indicator (Bulk Import Balance Limit's last upload) work on this path too
// without a second, separate rows fetch just for the timestamp.
export async function GET() {
  try {
    const [rows, lastImport] = await Promise.all([
      getAgentBalancesForBalancePage('cashout'),
      getBalanceLimitLastImport('cashout'),
    ]);
    return NextResponse.json({ rows, lastImport }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute agent balances';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
