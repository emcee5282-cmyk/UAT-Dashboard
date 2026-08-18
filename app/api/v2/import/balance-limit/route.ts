import { NextResponse } from 'next/server';
import { importBalanceLimitFile, type Product } from '@/app/lib/services/balanceLimitService';

// Phase 8b — Balance Limit's real upload endpoint. Same shape as
// /api/v2/import/settlement and /api/v2/import/topup: one shared route,
// `product` carried in the form data rather than a separate route per
// product. Writes to PostgreSQL only — never touches Google Sheets.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const product = formData.get('product');
    const uploadedBy = formData.get('uploadedBy');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    const result = await importBalanceLimitFile({
      product: product as Product,
      file,
      fileName: file.name,
      uploadedBy: typeof uploadedBy === 'string' && uploadedBy ? uploadedBy : 'unknown',
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
