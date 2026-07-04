import { NextResponse } from 'next/server';
import { fetchRange } from '@/app/lib/googleSheets';

export async function GET() {
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
