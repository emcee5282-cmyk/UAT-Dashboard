import { NextResponse } from 'next/server';
import { readTransferQueueRules, readBundleConfig, readMetaConfig } from '@/app/lib/transferQueueSettings';

export async function GET() {
  try {
    const [rules, bundle, meta] = await Promise.all([readTransferQueueRules(), readBundleConfig(), readMetaConfig()]);
    return NextResponse.json({ rules, bundle, meta }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching Transfer Queue configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
