import { NextResponse } from 'next/server';
import { updateCashoutWalletRemark } from '@/app/lib/walletStatus';
import { updateWalletRemarkPg } from '@/app/lib/services/walletStatusConfigService';

// Cashout-only flag — see app/api/wallet-status/route.ts's own comment.
function isPostgresSourceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WALLET_STATUS_SOURCE_CASHOUT === 'postgres';
}

const MAX_REMARK_LENGTH = 500;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const shopName = String(body?.shopName ?? '').trim();
    const remark = String(body?.remark ?? '').trim();

    if (!shopName || remark.length > MAX_REMARK_LENGTH) {
      return NextResponse.json({ error: 'Missing or invalid shopName/remark.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = isPostgresSourceEnabled()
      ? await updateWalletRemarkPg('cashout', shopName, remark)
      : await updateCashoutWalletRemark(shopName, remark);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating remark';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
