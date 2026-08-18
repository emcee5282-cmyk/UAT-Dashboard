import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { runFastSync, runSlowSync, SyncAlreadyRunningError, type SyncGroup } from '@/scripts/migrate-data';
import { getDb } from '@/app/lib/db/client';
import * as schema from '@/app/lib/db/schema';

// Scheduled Postgres sync trigger — meant to be called by a VPS cron job
// (`curl -X POST .../api/admin/sync-postgres?group=fast|slow`), NOT by any
// dashboard page. Runs on the persistent PM2-managed Node process, so it
// has no serverless execution-time ceiling (unlike Vercel) — required
// here, since the "slow" group alone is realistically 20-40+ minutes
// against the remote DB.
//
// Google Sheets remains read-only throughout — this only reads Sheets and
// writes Postgres, via runFastSync()/runSlowSync() (scripts/migrate-data.ts,
// same functions the CLI entry point uses — no separate logic here). Does
// not touch any dashboard read path; no page or existing API route calls
// this. Per-group overlap protection and run history live in the
// `sync_runs` table (see runGroupSync() in migrate-data.ts) rather than an
// in-memory flag, so it survives a process restart correctly.
//
// Protected by a shared secret (no auth system exists yet) — set
// SYNC_SECRET in the VPS's .env and pass it as `Authorization: Bearer
// <secret>`. Missing/misconfigured secret fails closed (403), not open.
// GET (status) requires the same secret — it exposes internal counts/
// error messages, not meant to be public.

function checkAuth(request: Request): NextResponse | null {
  const secret = process.env.SYNC_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'SYNC_SECRET not configured on the server' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return null;
}

function parseGroup(request: Request): SyncGroup | null {
  const url = new URL(request.url);
  const group = url.searchParams.get('group');
  return group === 'fast' || group === 'slow' ? group : null;
}

export async function POST(request: Request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const group = parseGroup(request);
  if (!group) {
    return NextResponse.json({ error: 'Missing or invalid ?group= — expected "fast" or "slow"' }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  try {
    if (group === 'fast') await runFastSync();
    else await runSlowSync();
    return NextResponse.json({ ok: true, group, startedAt, finishedAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ ok: false, group, startedAt, error: message }, { status: 500 });
  }
}

// Status check — "last successful sync per group" + latest run overall,
// so sync health is verifiable without SSH/database access.
export async function GET(request: Request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const db = getDb();
  const groups: SyncGroup[] = ['fast', 'slow'];
  const result: Record<string, unknown> = {};

  for (const group of groups) {
    const [latest] = await db
      .select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.syncGroup, group))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1);
    const [lastSuccess] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.syncGroup, group), eq(schema.syncRuns.status, 'success')))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1);

    result[group] = {
      latest: latest
        ? {
            status: latest.status,
            startedAt: latest.startedAt,
            finishedAt: latest.finishedAt,
            inserted: latest.insertedTotal,
            updated: latest.updatedTotal,
            skipped: latest.skippedTotal,
            rejected: latest.rejectedTotal,
            error: latest.errorMessage,
          }
        : null,
      lastSuccessfulSync: lastSuccess
        ? {
            startedAt: lastSuccess.startedAt,
            finishedAt: lastSuccess.finishedAt,
            inserted: lastSuccess.insertedTotal,
            updated: lastSuccess.updatedTotal,
            skipped: lastSuccess.skippedTotal,
            rejected: lastSuccess.rejectedTotal,
          }
        : null,
    };
  }

  return NextResponse.json(result);
}
