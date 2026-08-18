import { NextResponse } from 'next/server';
import { setTransferQueueMode, type TransferQueueMode } from '@/app/lib/transferQueueSettings';
import { setTransferQueueModePg } from '@/app/lib/services/transferQueueConfigService';

const VALID_MODES: TransferQueueMode[] = ['production', 'configuration'];

// Same shared flag as the sibling GET route — see its own comment.
function isPostgresSourceEnabled(): boolean {
  return process.env.TRANSFER_QUEUE_CONFIG_SOURCE === 'postgres';
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const mode = body?.mode as TransferQueueMode;

    if (!VALID_MODES.includes(mode)) {
      return NextResponse.json({ error: 'Missing or invalid mode.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = isPostgresSourceEnabled()
      ? await setTransferQueueModePg(mode)
      : await setTransferQueueMode(mode);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating Transfer Queue mode';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
