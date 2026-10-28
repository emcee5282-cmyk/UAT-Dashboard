import { NextResponse } from 'next/server';
import { getWalletStatusRows } from '@/app/lib/services/walletStatusService';
import { authorizeApi } from '@/app/lib/auth/guard';

// LOCAL/FOUNDATION ONLY — Postgres-backed equivalent of /api/wallet-status.
export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = await getWalletStatusRows('cashout');
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute wallet status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
