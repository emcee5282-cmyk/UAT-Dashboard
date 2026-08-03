import { NextResponse } from 'next/server';
import { readTransferQueueRules, readBundleConfig } from '@/app/lib/transferQueueSettings';

export async function GET() {
  try {
    const [rules, bundle] = await Promise.all([readTransferQueueRules(), readBundleConfig()]);
    return NextResponse.json({ rules, bundle }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching Transfer Queue configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
