// LOCAL-ONLY sync scheduler — a manually started foreground process that
// simulates the future scheduled sync architecture (VPS cron -> sync API)
// on localhost only. Never imported by the application, never started by
// `npm run dev`. Run it yourself, in its own terminal, when you want to
// observe fast/slow sync running on a recurring cadence locally:
//
//   npx tsx --env-file=.env.local scripts/local-scheduler.ts
//
// Stop with Ctrl+C (SIGINT) at any time.
//
// This script does not touch middleware.ts, session.ts, credentials.ts, the
// sync route, or migrate-data.ts — it only calls the existing HTTP
// endpoints exactly as a real caller (eventually a VPS cron) would, using
// the same login + SYNC_SECRET combination already proven manually earlier
// in this project's migration work.
//
// Reliability hardening (this pass): network errors and 5xx responses now
// get a small bounded retry (initial attempt + 2 retries, fixed 5s/15s
// delays) with elapsed-time logging at every step, before giving up for
// that tick and waiting for the next scheduled run — a failed tick never
// stops the timers. HTTP 409 (another sync of the same group already
// running) and HTTP 401 (session re-auth) are unchanged: 409 is a normal,
// non-retried collision; 401 keeps its existing one-time re-login + retry,
// independent of the new retry counter. Other 4xx are never retried.

import { config } from 'dotenv';
config({ path: '.env.local' });

// ---------------------------------------------------------------------------
// Localhost safety — hardcoded, not configurable via any env var, on purpose.
// A configurable base URL is a copy-paste accident waiting to point this at
// production; hardcoding it removes that path entirely.
// ---------------------------------------------------------------------------
const BASE_URL = 'http://localhost:3000';

function assertLocalhostTarget(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    console.error(`[SAFETY] Refusing to run — target host is "${parsed.hostname}", not localhost.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Scheduling intervals
// ---------------------------------------------------------------------------
// SLOW — mirrors the project's one documented design target
// (scripts/migrate-data.ts's own comment: "schedule is every 2h"). This is
// a LOCAL SIMULATION of that target, not a production scheduling change.
const SLOW_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// FAST — the codebase intentionally does NOT define a production cadence
// for fast sync. 5 minutes here is a LOCAL TESTING interval ONLY, chosen to
// make repeated executions observable in a reasonable session — it is NOT a
// production recommendation.
const FAST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — LOCAL TESTING ONLY

const DEV_USERNAME = 'admin';
const DEV_PASSWORD = 'admin123';

type SyncGroup = 'fast' | 'slow';

let sessionCookie: string | null = null;
let shuttingDown = false;
let fastTimer: ReturnType<typeof setInterval> | null = null;
let slowTimer: ReturnType<typeof setInterval> | null = null;

function nowLabel(): string {
  return new Date().toLocaleString();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Sub-second precision for individual attempt timings (network errors,
// completed calls, retries) — formatDuration's whole-second rounding is
// fine for interval descriptions but hides useful detail here (e.g. "a
// network error after 2.1s" vs "0s").
function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function timeOnly(): string {
  return new Date().toLocaleTimeString();
}

function groupTag(group: SyncGroup): string {
  return `[${group.toUpperCase()}]`;
}

// ---------------------------------------------------------------------------
// Bounded retry policy for network errors and 5xx/transient server errors.
// Deliberately small and fixed (no backoff framework, no config knob) — this
// is local testing hardening, not a production retry system. HTTP 409
// (another sync of the same group already running) and HTTP 401 (session
// handling, unchanged below) never go through this path.
// ---------------------------------------------------------------------------
const MAX_RETRIES = 2; // initial attempt + 2 retries = 3 attempts total per tick
const RETRY_DELAYS_MS = [5_000, 15_000]; // delay before retry 1, delay before retry 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

// Extracts the dashboard_session cookie value from a Set-Cookie response —
// never logged, kept only in memory for the life of this process.
function extractSessionCookie(res: Response): string | null {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const rawCookies = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : [res.headers.get('set-cookie') ?? ''];
  for (const raw of rawCookies) {
    const match = raw.match(/dashboard_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function login(): Promise<void> {
  console.log('[AUTH] Logging in...');
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: DEV_USERNAME, password: DEV_PASSWORD, rememberMe: true }),
  });
  if (!res.ok) {
    console.error(`[AUTH] Login failed — HTTP ${res.status}`);
    process.exit(1);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) {
    console.error('[AUTH] Login succeeded but no session cookie was returned.');
    process.exit(1);
  }
  sessionCookie = cookie;
  console.log('[AUTH] Session established.');
}

type SyncOutcome = { status: number; ok: boolean; skipped: boolean; bodyText: string };

async function callSyncEndpoint(group: SyncGroup, syncSecret: string): Promise<SyncOutcome> {
  const res = await fetch(`${BASE_URL}/api/admin/sync-postgres?group=${group}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${syncSecret}`,
      Cookie: `dashboard_session=${sessionCookie}`,
    },
  });
  const bodyText = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, skipped: res.status === 409, bodyText };
}

// Truncated, response-only text — never includes request headers, so the
// Authorization/Cookie values sent above can never leak through this path.
function safeResponseSnippet(bodyText: string): string {
  const trimmed = bodyText.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

// One HTTP call, timed. Never throws — network failures are captured in the
// return value so the caller's retry loop has one uniform shape to branch
// on instead of a try/catch at every call site.
type AttemptResult =
  | { kind: 'network'; err: unknown; elapsedMs: number }
  | { kind: 'http'; outcome: SyncOutcome; elapsedMs: number };

async function attemptSync(group: SyncGroup, syncSecret: string): Promise<AttemptResult> {
  const start = Date.now();
  try {
    const outcome = await callSyncEndpoint(group, syncSecret);
    return { kind: 'http', outcome, elapsedMs: Date.now() - start };
  } catch (err) {
    return { kind: 'network', err, elapsedMs: Date.now() - start };
  }
}

async function runSync(group: SyncGroup, syncSecret: string): Promise<void> {
  const tag = groupTag(group);
  console.log(`\n${tag} Started at ${timeOnly()}`);

  let result = await attemptSync(group, syncSecret);

  // Exactly one re-login + one retry on 401, unchanged from before — this is
  // session handling, not part of the network/5xx retry policy below, and
  // does not consume a retry slot.
  if (result.kind === 'http' && result.outcome.status === 401) {
    console.log(`${tag} Session expired (HTTP 401). Re-logging in once...`);
    try {
      await login();
      result = await attemptSync(group, syncSecret);
    } catch (err) {
      console.error(`${tag} FAILED — re-login/retry did not succeed.`);
      console.error(`${tag} ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  let retryCount = 0;
  for (;;) {
    if (result.kind === 'http') {
      const { outcome, elapsedMs } = result;

      // HTTP 409 is a normal collision (another sync of this group already
      // running), never a failure and never retried.
      if (outcome.skipped) {
        console.log(`${tag} HTTP 409`);
        console.log(`${tag} Skipped: another ${group.toUpperCase()} sync is already running`);
        return;
      }

      if (outcome.ok) {
        console.log(`${tag} HTTP ${outcome.status}`);
        console.log(
          retryCount > 0
            ? `${tag} Retry ${retryCount} succeeded after ${formatElapsed(elapsedMs)}`
            : `${tag} Completed in ${formatElapsed(elapsedMs)}`
        );
        return;
      }

      if (!isRetryableStatus(outcome.status)) {
        // Other 4xx (400/403/404/...) — never blindly retried.
        console.error(`${tag} HTTP ${outcome.status}`);
        console.error(`${tag} Failed: ${safeResponseSnippet(outcome.bodyText)}`);
        return;
      }

      // 5xx — treated like a network error: bounded retry below.
      console.error(
        retryCount > 0
          ? `${tag} Retry ${retryCount} failed after ${formatElapsed(elapsedMs)}: HTTP ${outcome.status}`
          : `${tag} HTTP ${outcome.status} after ${formatElapsed(elapsedMs)}: ${safeResponseSnippet(outcome.bodyText)}`
      );
    } else {
      const { err, elapsedMs } = result;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        retryCount > 0
          ? `${tag} Retry ${retryCount} failed after ${formatElapsed(elapsedMs)}: ${message}`
          : `${tag} Network error after ${formatElapsed(elapsedMs)}: ${message}`
      );
    }

    if (retryCount >= MAX_RETRIES) {
      console.error(`${tag} Tick failed after ${MAX_RETRIES + 1} attempts`);
      console.error(`${tag} Scheduler remains active`);
      return;
    }

    retryCount += 1;
    const delayMs = RETRY_DELAYS_MS[retryCount - 1];
    console.log(`${tag} Retry ${retryCount}/${MAX_RETRIES} in ${Math.round(delayMs / 1000)}s`);
    await sleep(delayMs);
    console.log(`${tag} Retry ${retryCount} started`);
    result = await attemptSync(group, syncSecret);
  }
}

// Takes the next run's absolute timestamp directly, rather than an interval
// to add to "now" — computing it as Date.now() + intervalMs from inside the
// post-sync .then() (the original approach) silently drifts by however long
// the sync + any retries took (confirmed live: a 99.4s FAST run made the
// printed "next run" ~99s later than the real next setInterval firing).
// setInterval itself doesn't drift this way (each firing is anchored to
// startTimers()'s own registration, independent of how long a previous
// callback's async work took), so the log should reflect that same anchor —
// each tick captures its own fire time and adds the interval to THAT.
function scheduleNext(group: SyncGroup, nextRunAt: number): void {
  console.log(`${groupTag(group)} Next scheduled run: ${new Date(nextRunAt).toLocaleString()}`);
}

function startTimers(syncSecret: string): void {
  fastTimer = setInterval(() => {
    if (shuttingDown) return;
    const tickAt = Date.now();
    runSync('fast', syncSecret).then(() => scheduleNext('fast', tickAt + FAST_INTERVAL_MS));
  }, FAST_INTERVAL_MS);

  slowTimer = setInterval(() => {
    if (shuttingDown) return;
    const tickAt = Date.now();
    runSync('slow', syncSecret).then(() => scheduleNext('slow', tickAt + SLOW_INTERVAL_MS));
  }, SLOW_INTERVAL_MS);

  scheduleNext('fast', Date.now() + FAST_INTERVAL_MS);
  scheduleNext('slow', Date.now() + SLOW_INTERVAL_MS);
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SHUTDOWN] Received ${signal}. Stopping timers...`);
  if (fastTimer) clearInterval(fastTimer);
  if (slowTimer) clearInterval(slowTimer);
  console.log('[SHUTDOWN] No new syncs will be started. Exiting.');
  process.exit(0);
}

async function main(): Promise<void> {
  assertLocalhostTarget(BASE_URL);

  console.log('='.repeat(50));
  console.log('LOCAL POSTGRES SYNC SCHEDULER');
  console.log(`Target: ${BASE_URL}`);
  console.log('Mode: LOCAL TESTING ONLY');
  console.log('='.repeat(50));

  const syncSecret = process.env.SYNC_SECRET;
  if (!syncSecret) {
    console.error('[AUTH] SYNC_SECRET is not set in the local environment. Aborting.');
    process.exit(1);
  }

  console.log(`\n[STARTUP] Checking ${BASE_URL} is reachable...`);
  try {
    await fetch(BASE_URL, { method: 'GET' });
  } catch (err) {
    console.error(`[STARTUP] Could not reach ${BASE_URL} — is the dev server running?`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log('[STARTUP] Server is reachable.');

  console.log('');
  await login();
  console.log('[AUTH] SYNC_SECRET detected.');

  await runSync('fast', syncSecret);
  await runSync('slow', syncSecret);

  console.log('\n[SCHEDULER] Starting recurring timers...');
  console.log(`[SCHEDULER] FAST interval: ${formatDuration(FAST_INTERVAL_MS)} (LOCAL TESTING ONLY, not a production cadence)`);
  console.log(`[SCHEDULER] SLOW interval: ${formatDuration(SLOW_INTERVAL_MS)} (mirrors the documented design target)`);
  startTimers(syncSecret);

  console.log('\n[SCHEDULER] Running. Press Ctrl+C to stop.');
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
