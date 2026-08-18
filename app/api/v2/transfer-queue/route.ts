import { NextResponse } from 'next/server';
import { getCashoutTransferQueueRows, getSendMoneyTransferQueueRows } from '@/app/lib/services/transferQueueService';

// Transfer Queue's Postgres-mode read — wraps transferQueueService.ts's
// per-wallet queue builders (Phase 1, restructured to iterate per wallet
// after the JETT013 finding). Reads PostgreSQL only: Company Balance/
// Balance Inside/Discrepancy/SDP VS Balance via balanceService.ts's
// getAgentBalances() (the exact same figures the Balance page shows),
// Current Group via agent_wallets.group_code, rule thresholds via
// transfer_queue_rules — zero Google Sheets calls in this runtime path.
export async function GET(request: Request) {
  try {
    const product = new URL(request.url).searchParams.get('product');
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    const rows = product === 'cashout'
      ? await getCashoutTransferQueueRows()
      : await getSendMoneyTransferQueueRows();

    return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch Transfer Queue rows';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
