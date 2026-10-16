import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { SESSION_COOKIE_NAME } from '@/app/lib/auth/session';
import { runDiscrepancyTgSend } from '@/app/lib/server/discrepancyTgSendService';

export const runtime = 'nodejs';
// Generous ceiling for a synchronous run (many leaders x multiple images
// each, paced ~1s apart) — Vercel's own plan limits may still cap this
// lower there; the self-hosted VPS (a long-running Node process, no
// per-request timeout) has no such ceiling regardless.
export const maxDuration = 300;

// NDJSON stream, one JSON object per line: zero or more
// {"type":"progress","sentMessages":N,"totalMessages":N} lines as the run
// goes, then exactly one {"type":"done","outcome":{...}} or
// {"type":"error","error":"...","status":N} line before the stream
// closes. Lets the confirmation pop-up show real "Sending… X / N"
// progress from ONE request, without a separate job/polling endpoint.
export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  // INTERNAL_BASE_URL bypasses nginx on IP-restricted deployments where the
  // box's own outbound request back to its public domain would otherwise
  // be blocked — same reasoning as the existing Dashboard screenshot route.
  const origin = process.env.INTERNAL_BASE_URL || request.nextUrl.origin;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const outcome = await runDiscrepancyTgSend(session.username, origin, sessionToken, (progress) => write({ type: 'progress', ...progress }));
        write({ type: 'done', outcome });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to send to TG';
        const status = message === 'A send is already in progress' ? 409 : 500;
        write({ type: 'error', error: message, status });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
}
