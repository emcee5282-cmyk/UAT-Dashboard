import { NextResponse } from 'next/server';
import { readSendMoneyWalletStatus, readSendMoneyWalletRemarks, readSendMoneyWalletOverrides, mergeWalletStatusRemarksAndOverrides } from '@/app/lib/walletStatus';
import { readWalletStatusOverridesPg } from '@/app/lib/db/read/walletStatus';

// Send Money-only flag, deliberately separate from Cashout's own — the two
// products cut over independently (Send Money has no roster gap blocking
// it; Cashout is held back pending the 1,479-shadow-agent investigation).
// One switch still gates this GET route and all its Send Money write
// siblings together, so there's never a window where a save lands only in
// Sheets while a read already comes from Postgres.
function isPostgresSourceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WALLET_STATUS_SOURCE_SENDMONEY === 'postgres';
}

export async function GET() {
  try {
    if (isPostgresSourceEnabled()) {
      const data = await readWalletStatusOverridesPg('sendmoney');
      return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }

    const [status, remarks, overrides] = await Promise.all([readSendMoneyWalletStatus(), readSendMoneyWalletRemarks(), readSendMoneyWalletOverrides()]);
    return NextResponse.json(mergeWalletStatusRemarksAndOverrides(status, remarks, overrides), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching wallet status data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
