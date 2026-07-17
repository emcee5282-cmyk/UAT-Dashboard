import { NextResponse } from 'next/server';
import { readCashoutEstimatedOpening, readImportLog } from '@/app/lib/estimatedOpening';

export async function GET() {
  try {
    const [{ balances, balancesWithFallback, walletTotals, uploadedAt }, importLog] = await Promise.all([
      readCashoutEstimatedOpening(),
      readImportLog(),
    ]);
    // Import Log is appended oldest-first, so the last entry is the most
    // recent upload — the only one the modal's "Last Import" section needs.
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
