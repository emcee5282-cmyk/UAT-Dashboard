import { NextResponse } from 'next/server';
import { readCashoutWalletStatus, readCashoutWalletRemarks, readCashoutWalletOverrides, mergeWalletStatusRemarksAndOverrides } from '@/app/lib/walletStatus';

export async function GET() {
  try {
    const [status, remarks, overrides] = await Promise.all([readCashoutWalletStatus(), readCashoutWalletRemarks(), readCashoutWalletOverrides()]);
    return NextResponse.json(mergeWalletStatusRemarksAndOverrides(status, remarks, overrides), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching wallet status data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
