import { NextResponse } from 'next/server';
import { readSendMoneyEstimatedOpening, readSendMoneyImportLog } from '@/app/lib/estimatedOpening';

export async function GET() {
  try {
    const [{ balances, balancesWithFallback, walletTotals, uploadedAt }, importLog] = await Promise.all([
      readSendMoneyEstimatedOpening(),
      readSendMoneyImportLog(),
    ]);
    const lastImport = importLog.length > 0 ? importLog[importLog.length - 1] : null;
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
