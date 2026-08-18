import { NextResponse } from 'next/server';
import { updateCashoutWalletStatusField, type WalletStatusField } from '@/app/lib/walletStatus';
import { updateWalletStatusFieldPg } from '@/app/lib/services/walletStatusConfigService';

// Cashout-only flag — see app/api/wallet-status/route.ts's own comment.
function isPostgresSourceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WALLET_STATUS_SOURCE_CASHOUT === 'postgres';
}

const VALID_FIELDS: WalletStatusField[] = ['deposit', 'withdrawal', 'priority', 'walletStatus'];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const shopName = String(body?.shopName ?? '').trim();
    const field = body?.field as WalletStatusField;
    const value = String(body?.value ?? '').trim();

    if (!shopName || !VALID_FIELDS.includes(field) || !value) {
      return NextResponse.json({ error: 'Missing or invalid shopName/field/value.' }, { status: 400 });
    }

    if (isPostgresSourceEnabled()) {
      await updateWalletStatusFieldPg('cashout', shopName, field, value);
      return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }

    await updateCashoutWalletStatusField(shopName, field, value);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating wallet status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
