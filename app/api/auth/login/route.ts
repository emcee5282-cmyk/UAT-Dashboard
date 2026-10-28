import { NextRequest, NextResponse } from 'next/server';
import { verifyCredentials } from '@/app/lib/auth/credentials';
import { createSession, sessionCookieOptions, verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';
import { homePathFor } from '@/app/lib/auth/permissions';

const GENERIC_ERROR = 'Invalid username or password.';

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required.' }, { status: 400 });
  }
  if (username.length > 100 || password.length > 200) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const meta = requestMeta(request);
  const user = await verifyCredentials(username, password, meta);
  if (!user) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const { token, maxAge } = await createSession(user.id, meta);
  await logAudit({ event: 'login_success', actorUserId: user.id, targetUserId: user.id, meta });

  // Landing page = first page this role can view (role permissions live in the DB).
  const fresh = await verifySessionToken(token);
  const redirectTo = user.mustChangePassword ? '/change-password' : homePathFor(fresh?.permissions);
  const response = NextResponse.json({ ok: true, role: user.role, mustChangePassword: user.mustChangePassword, redirectTo });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(maxAge));
  return response;
}
