import { NextResponse } from 'next/server';
import { getTransactionSignaturesForDates, type Product, type TransactionType } from '@/app/lib/services/transactionPageService';

// Bulk Import's "already imported" duplicate check — POST (not GET) because
// the distinct-dates list comes from the uploaded file's own contents, not
// a fixed param. See BulkImportModal.tsx's scanning step, which calls this
// alongside its existing parse/validate work (no separate loading state).
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const product = body?.product;
    const transactionType = body?.transactionType;
    const dates = body?.dates;

    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }
    if (transactionType !== 'settlement' && transactionType !== 'topup') {
      return NextResponse.json({ error: 'Missing or invalid transactionType (expected "settlement" or "topup")' }, { status: 400 });
    }
    if (!Array.isArray(dates) || dates.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      return NextResponse.json({ error: 'dates must be an array of "YYYY-MM-DD" strings' }, { status: 400 });
    }

    const rows = await getTransactionSignaturesForDates(product as Product, transactionType as TransactionType, dates);
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to check existing records';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
