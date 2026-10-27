import { NextResponse } from 'next/server';
import { sendStagnantBalanceTg } from '@/app/lib/services/stagnantBalanceTgService';

// Daily 2AM (Manila) Stagnant Balances Excel → Telegram send — called by a
// VPS cron job, not by any page. /api/cron/* is exempt from the session
// gate in middleware.ts, so this route MUST check its own bearer secret
// (CRON_SECRET) and fails closed when it isn't configured. Optional
// `?date=YYYY-MM-DD` re-sends a specific business date (manual catch-up).
function checkAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured on the server' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return null;
}

export async function POST(request: Request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const date = new URL(request.url).searchParams.get('date');
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const result = await sendStagnantBalanceTg(date ? { asOfDate: date } : undefined);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stagnant Balances TG send failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
