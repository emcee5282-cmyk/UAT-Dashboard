import { NextResponse } from 'next/server';
import { updateSendMoneyWalletRemark } from '@/app/lib/walletStatus';

const MAX_REMARK_LENGTH = 500;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const shopName = String(body?.shopName ?? '').trim();
    const remark = String(body?.remark ?? '').trim();

    if (!shopName || remark.length > MAX_REMARK_LENGTH) {
      return NextResponse.json({ error: 'Missing or invalid shopName/remark.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = await updateSendMoneyWalletRemark(shopName, remark);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating remark';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
