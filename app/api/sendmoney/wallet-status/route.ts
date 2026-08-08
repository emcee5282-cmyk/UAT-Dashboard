import { NextResponse } from 'next/server';
import { readSendMoneyWalletStatus, readSendMoneyWalletRemarks, readSendMoneyWalletOverrides, mergeWalletStatusRemarksAndOverrides } from '@/app/lib/walletStatus';

export async function GET() {
  try {
    const [status, remarks, overrides] = await Promise.all([readSendMoneyWalletStatus(), readSendMoneyWalletRemarks(), readSendMoneyWalletOverrides()]);
    return NextResponse.json(mergeWalletStatusRemarksAndOverrides(status, remarks, overrides), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching wallet status data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
