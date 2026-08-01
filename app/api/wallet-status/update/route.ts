import { NextResponse } from 'next/server';
import { updateCashoutWalletStatusField, type WalletStatusField } from '@/app/lib/walletStatus';

const VALID_FIELDS: WalletStatusField[] = ['deposit', 'withdrawal', 'priority'];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const shopName = String(body?.shopName ?? '').trim();
    const field = body?.field as WalletStatusField;
    const value = String(body?.value ?? '').trim();

    if (!shopName || !VALID_FIELDS.includes(field) || !value) {
      return NextResponse.json({ error: 'Missing or invalid shopName/field/value.' }, { status: 400 });
    }

    await updateCashoutWalletStatusField(shopName, field, value);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating wallet status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
