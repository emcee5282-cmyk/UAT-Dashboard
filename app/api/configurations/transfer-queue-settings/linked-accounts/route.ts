import { NextResponse } from 'next/server';
import { readLinkedCashoutAccounts } from '@/app/lib/transferQueueSettings';

export async function GET() {
  try {
    const map = await readLinkedCashoutAccounts();
    return NextResponse.json(Object.fromEntries(map), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching linked Cashout accounts';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
