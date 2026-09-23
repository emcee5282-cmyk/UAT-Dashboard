import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { runDailyTxnRollover } from '@/app/lib/services/dailyTxnRolloverService';
import { getDb } from '@/app/lib/db/client';
import * as schema from '@/app/lib/db/schema';

// Scheduled Daily Transaction Entry rollover — meant to be called by a VPS
// cron job (`curl -X POST .../api/admin/daily-txn-rollover`) once a day
// (~12:00 AM Manila), NOT by any dashboard page — see the "Data Recording"
// requirement on app/daily-txn-entry: a business day's data only becomes
// permanent history once that day has ended, never on live page load. Same
// bearer-secret pattern as app/api/admin/sync-postgres/route.ts (no auth
// system exists for server-to-server calls, so this fails closed rather
// than open). Idempotency (skip if already run for a given business date)
// lives in runDailyTxnRollover() itself via the daily_txn_rollover_runs
// table — this route is a thin trigger, no duplicate logic here.

function checkAuth(request: Request): NextResponse | null {
  const secret = process.env.DAILY_TXN_ROLLOVER_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'DAILY_TXN_ROLLOVER_SECRET not configured on the server' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return null;
}

export async function POST(request: Request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const result = await runDailyTxnRollover();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  if (result.skipped) {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}

// Status check — last few rollover runs, so this is verifiable without
// SSH/database access.
export async function GET(request: Request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const db = getDb();
  const runs = await db
    .select()
    .from(schema.dailyTxnRolloverRuns)
    .orderBy(desc(schema.dailyTxnRolloverRuns.businessDate))
    .limit(10);

  const [lastSuccess] = await db
    .select()
    .from(schema.dailyTxnRolloverRuns)
    .where(eq(schema.dailyTxnRolloverRuns.status, 'success'))
    .orderBy(desc(schema.dailyTxnRolloverRuns.businessDate))
    .limit(1);

  return NextResponse.json({
    recentRuns: runs,
    lastSuccessfulRollover: lastSuccess ?? null,
  });
}
