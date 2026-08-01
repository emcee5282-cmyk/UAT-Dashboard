import { NextResponse } from 'next/server';
import { readSendMoneyWalletStatus } from '@/app/lib/walletStatus';

export async function GET() {
  try {
    const entries = await readSendMoneyWalletStatus();
    return NextResponse.json(Object.fromEntries(entries), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching wallet status data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
