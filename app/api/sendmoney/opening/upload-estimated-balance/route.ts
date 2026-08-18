import { NextResponse } from 'next/server';
import { importEstimatedOpeningFromUpload } from '@/app/lib/services/estimatedOpeningService';

// Body: { headerRow: string[], dataRows: string[][], fileName: string } —
// same shape as Cashout's own upload route, already parsed client-side.
//
// LOCALHOST PHASE 2: writes directly to PostgreSQL, no Google Sheets call.
// A failed PostgreSQL transaction now correctly returns an error — no
// "Sheets succeeded, Postgres silently failed" split-brain response.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const headerRow: unknown = body?.headerRow;
    const dataRows: unknown = body?.dataRows;
    const fileName: unknown = body?.fileName;

    if (!Array.isArray(headerRow) || !Array.isArray(dataRows)) {
      return NextResponse.json({ error: 'Expected { headerRow: string[], dataRows: string[][] }' }, { status: 400 });
    }

    const result = await importEstimatedOpeningFromUpload(
      'sendmoney',
      headerRow,
      dataRows,
      typeof fileName === 'string' ? fileName : 'unknown.xlsx'
    );
    console.log(`[PG_UPLOAD_OK] opening/sendmoney uploadedAt=${result.uploadedAt} shopCount=${result.shopCount}`);

    return NextResponse.json({ ok: true, uploadedAt: result.uploadedAt, shopCount: result.shopCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error uploading estimated opening data';
    console.error('[PG_UPLOAD_FAILED] opening/sendmoney', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
