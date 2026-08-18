import { NextResponse } from 'next/server';
import { importTopUpFile, type Product } from '@/app/lib/services/importService';

// LOCAL/FOUNDATION ONLY — see app/api/v2/import/settlement/route.ts for the
// full explanation (identical pattern, Top Up-specific import function).
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

    let excludedRows: Set<number> | undefined;
    if (typeof excludedRowsRaw === 'string' && excludedRowsRaw) {
      const parsed = JSON.parse(excludedRowsRaw);
      if (Array.isArray(parsed)) excludedRows = new Set(parsed.filter((n) => typeof n === 'number'));
    }

    const result = await importTopUpFile({
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
