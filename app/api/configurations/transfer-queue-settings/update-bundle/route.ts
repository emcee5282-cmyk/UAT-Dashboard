import { NextResponse } from 'next/server';
import { updateBundleField } from '@/app/lib/transferQueueSettings';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const index = Number(body?.index);
    const value = String(body?.value ?? '').trim();

    if (!Number.isInteger(index) || !value) {
      return NextResponse.json({ error: 'Missing or invalid index/value.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = await updateBundleField(index, value);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating Bundle configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
