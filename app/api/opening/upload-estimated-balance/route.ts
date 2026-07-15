import { NextResponse } from 'next/server';
import { writeCashoutEstimatedOpening } from '@/app/lib/estimatedOpening';

// Body: { headerRow: string[], dataRows: string[][], fileName: string } —
// already parsed client-side from the uploaded Excel file (same xlsx
// library the rest of the app already uses for exports), so this route
// just persists it. fileName is only used for the Import Log entry.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const headerRow: unknown = body?.headerRow;
    const dataRows: unknown = body?.dataRows;
    const fileName: unknown = body?.fileName;

    if (!Array.isArray(headerRow) || !Array.isArray(dataRows)) {
      return NextResponse.json({ error: 'Expected { headerRow: string[], dataRows: string[][] }' }, { status: 400 });
    }

    const result = await writeCashoutEstimatedOpening(headerRow, dataRows, typeof fileName === 'string' ? fileName : 'unknown.xlsx');
    return NextResponse.json({ ok: true, uploadedAt: result.uploadedAt, shopCount: result.shopCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error uploading estimated opening data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
