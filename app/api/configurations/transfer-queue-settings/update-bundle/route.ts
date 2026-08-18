import { NextResponse } from 'next/server';
import { updateBundleField, DEFAULT_BUNDLE } from '@/app/lib/transferQueueSettings';
import { updateBundleFieldPg } from '@/app/lib/services/transferQueueConfigService';

// Same shared flag as the sibling GET route — see its own comment.
function isPostgresSourceEnabled(): boolean {
  return process.env.TRANSFER_QUEUE_CONFIG_SOURCE === 'postgres';
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const index = Number(body?.index);
    const value = String(body?.value ?? '').trim();

    if (!Number.isInteger(index) || !value) {
      return NextResponse.json({ error: 'Missing or invalid index/value.' }, { status: 400 });
    }

    if (isPostgresSourceEnabled()) {
      const field = DEFAULT_BUNDLE[index];
      if (!field) {
        return NextResponse.json({ error: 'Invalid bundle field index.' }, { status: 400 });
      }
      const { updatedBy, updatedAt } = await updateBundleFieldPg(field.field, value);
      return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const { updatedBy, updatedAt } = await updateBundleField(index, value);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating Bundle configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
