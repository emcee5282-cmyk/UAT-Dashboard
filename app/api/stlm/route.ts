import { NextResponse } from 'next/server';
import { fetchRange, toCSV } from '@/app/lib/googleSheets';
import { authorizeApi } from '@/app/lib/auth/guard';

export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = await fetchRange('Stlm Top Up');
    return new NextResponse(toCSV(rows), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching sheet';
    return new NextResponse(message, { status: 500 });
  }
}
