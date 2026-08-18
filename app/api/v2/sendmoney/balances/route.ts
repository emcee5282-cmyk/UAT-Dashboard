import { NextResponse } from 'next/server';
import { getAgentBalances } from '@/app/lib/services/balanceService';

// LOCAL/FOUNDATION ONLY — Send Money equivalent of /api/v2/agentbal. See
// that route for the full explanation.
export async function GET() {
  try {
    const rows = await getAgentBalances('sendmoney');
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute agent balances';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
