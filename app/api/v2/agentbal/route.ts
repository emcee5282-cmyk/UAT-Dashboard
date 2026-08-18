import { NextResponse } from 'next/server';
import { getAgentBalances } from '@/app/lib/services/balanceService';

// LOCAL/FOUNDATION ONLY — Postgres-backed equivalent of /api/agentbal +
// client-side balanceEngine.ts calculations, all now computed server-side.
// Not linked from any page; /api/agentbal (Sheets-based) is completely
// untouched and remains what app/agentbal/page.tsx actually uses.
export async function GET() {
  try {
    const rows = await getAgentBalances('cashout');
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute agent balances';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
