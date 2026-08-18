import { NextResponse } from 'next/server';
import { getSendMoneyTransferQueueRows } from '@/app/lib/services/transferQueueService';

// LOCAL/FOUNDATION ONLY — Send Money equivalent of /api/v2/transfer-queue.
// Bundle-wallet resolution against a linked Cashout account balance is not
// wired in this pass — see transferQueueService.ts's own comment; Bundle
// rows will come back with resolved=null rather than a guessed value.
export async function GET() {
  try {
    const rows = await getSendMoneyTransferQueueRows();
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute transfer queue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
