import { NextResponse } from 'next/server';
import { readEstimatedOpeningDisplayPg } from '@/app/lib/db/read/estimatedOpening';
import { authorizeApi } from '@/app/lib/auth/guard';

// LOCALHOST PHASE 3: reads directly from PostgreSQL — no Google Sheets call.
export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { balances, balancesWithFallback, walletTotals, uploadedAt, lastImport } = await readEstimatedOpeningDisplayPg('cashout');
    return NextResponse.json(
      {
        balances: Object.fromEntries(balances),
        balancesWithFallback: Object.fromEntries(balancesWithFallback),
        walletTotals: Object.fromEntries(walletTotals),
        uploadedAt: uploadedAt ? uploadedAt.toISOString() : null,
        lastImport,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching estimated opening data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
