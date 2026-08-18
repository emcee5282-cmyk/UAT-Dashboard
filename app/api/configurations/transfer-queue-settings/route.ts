import { NextResponse } from 'next/server';
import { readTransferQueueRules, readBundleConfig, readMetaConfig } from '@/app/lib/transferQueueSettings';
import { readTransferQueueRulesPg, readBundleConfigPg, readMetaConfigPg } from '@/app/lib/db/read/transferQueue';

// Phase 4 — page-scoped data-source override, server-only (no NEXT_PUBLIC_
// prefix needed: this route decides internally, the client never branches
// on it). Explicit opt-in only: any value other than the literal 'postgres'
// keeps this route on Google Sheets, its always-safe default. Deliberately
// gates BOTH this read route and all 3 write routes (update-rule/
// update-mode/update-bundle) together under the same flag — reads and
// writes for one admin surface must never disagree on which store is live.
function isPostgresSourceEnabled(): boolean {
  return process.env.TRANSFER_QUEUE_CONFIG_SOURCE === 'postgres';
}

export async function GET() {
  try {
    const [rules, bundle, meta] = isPostgresSourceEnabled()
      ? await Promise.all([readTransferQueueRulesPg(), readBundleConfigPg(), readMetaConfigPg()])
      : await Promise.all([readTransferQueueRules(), readBundleConfig(), readMetaConfig()]);
    return NextResponse.json({ rules, bundle, meta }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching Transfer Queue configuration';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
