import { NextResponse } from 'next/server';
import { fetchRange } from '@/app/lib/googleSheets';
import { authorizeApi } from '@/app/lib/auth/guard';

export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = await fetchRange('SSP PS BalanceLimit');
    return NextResponse.json(rows, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch balance limit data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
