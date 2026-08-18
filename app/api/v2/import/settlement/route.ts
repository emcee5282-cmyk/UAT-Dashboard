import { NextResponse } from 'next/server';
import { importSettlementFile, type Product } from '@/app/lib/services/importService';

// LOCAL/FOUNDATION ONLY — not linked from any existing page. Protected by
// the same session-cookie middleware as every other /api/* route (see
// middleware.ts) — no separate auth needed for local testing.
//
// Writes to PostgreSQL only. Never touches Google Sheets — this is a new,
// independent write path, not a replacement for the existing (real)
// Sheets-based Settlement flow, which remains completely untouched.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const product = formData.get('product');
    const uploadedBy = formData.get('uploadedBy');
    const excludedRowsRaw = formData.get('excludedRows');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    // Row numbers the user Skipped client-side (e.g. a flagged duplicate) —
    // an explicit exclusion list, never the file bytes themselves. The file
    // is still parsed and validated here in full; this only trims what
    // actually gets inserted afterward (see insertTransactionRows).
    let excludedRows: Set<number> | undefined;
    if (typeof excludedRowsRaw === 'string' && excludedRowsRaw) {
      const parsed = JSON.parse(excludedRowsRaw);
      if (Array.isArray(parsed)) excludedRows = new Set(parsed.filter((n) => typeof n === 'number'));
    }

    const result = await importSettlementFile({
      product: product as Product,
      file,
      fileName: file.name,
      uploadedBy: typeof uploadedBy === 'string' && uploadedBy ? uploadedBy : 'unknown',
      excludedRows,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
