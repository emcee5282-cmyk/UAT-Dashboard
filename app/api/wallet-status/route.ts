import { NextResponse } from 'next/server';
import { readCashoutWalletStatus, readCashoutWalletRemarks, mergeWalletStatusAndRemarks } from '@/app/lib/walletStatus';

export async function GET() {
  try {
    const [status, remarks] = await Promise.all([readCashoutWalletStatus(), readCashoutWalletRemarks()]);
    return NextResponse.json(mergeWalletStatusAndRemarks(status, remarks), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching wallet status data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
