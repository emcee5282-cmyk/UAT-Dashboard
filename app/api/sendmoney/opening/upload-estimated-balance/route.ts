import { NextResponse } from 'next/server';
import { importEstimatedTransactionsUpload, getEstimateShopWallets } from '@/app/lib/services/estimatedOpeningService';
import { authorizeApi } from '@/app/lib/auth/guard';

// The shops (and their Opening wallet lines) this upload can add to — the
// preview flags any transaction for the day that matches none of them.
export async function GET(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ shops: await getEstimateShopWallets('sendmoney') });
  } catch (err) {
    console.error('[PG_READ_FAILED] opening/sendmoney estimate shops', err);
    return NextResponse.json({ error: 'Could not load the shop list.' }, { status: 500 });
  }
}

// Body: { kind: 'dp' | 'wd', wallets: EstimateWalletSum[], fileName: string }
// — the Deposit (DP) or Payout (WD) export, already added up per wallet and
// per Updated Time day in the browser (app/lib/estimateTransactions.ts).
// Same shape as Cashout's own upload route. The server keeps only the day
// this upload counts for and merges in that day's other side
// (importEstimatedTransactionsUpload).
export async function POST(request: Request) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await request.json();
    const fileName: unknown = body?.fileName;

    const result = await importEstimatedTransactionsUpload(
      'sendmoney',
      body?.kind,
      body?.wallets,
      typeof fileName === 'string' ? fileName : 'unknown.xlsx'
    );
    console.log(`[PG_UPLOAD_OK] opening/sendmoney kind=${result.kind} day=${result.activityDate} uploadedAt=${result.uploadedAt} shopCount=${result.shopCount}`);

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error uploading estimated opening data';
    console.error('[PG_UPLOAD_FAILED] opening/sendmoney', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
