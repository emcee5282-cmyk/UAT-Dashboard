import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { SESSION_COOKIE_NAME } from '@/app/lib/auth/session';
import { runUnreconciledTgSend } from '@/app/lib/server/unreconciledTgSendService';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Same NDJSON streaming contract as /api/configurations/discrepancy-tg/send
// — zero or more {"type":"progress",...} lines, then exactly one
// {"type":"done","outcome":{...}} or {"type":"error",...} line.
export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const origin = process.env.INTERNAL_BASE_URL || request.nextUrl.origin;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const outcome = await runUnreconciledTgSend(session.username, origin, sessionToken, (progress) => write({ type: 'progress', ...progress }));
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
