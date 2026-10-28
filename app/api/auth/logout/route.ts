import { NextRequest, NextResponse } from 'next/server';
import { revokeSessionToken, sessionCookieOptions, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';

export async function POST(request: NextRequest) {
  // Revoke server-side first — clearing the cookie alone would leave a
  // copied token valid until it expired.
  const userId = await revokeSessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (userId) {
    await logAudit({ event: 'logout', actorUserId: userId, targetUserId: userId, meta: requestMeta(request) });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, '', sessionCookieOptions(0));
  return response;
}
