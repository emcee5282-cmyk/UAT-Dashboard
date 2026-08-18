import { NextRequest, NextResponse } from 'next/server';
import { verifyCredentials } from '@/app/lib/auth/credentials';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

export async function POST(request: NextRequest) {
  let body: { username?: string; password?: string; rememberMe?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required.' }, { status: 400 });
  }

  if (!verifyCredentials(username, password)) {
    return NextResponse.json({ error: 'Invalid username or password.' }, { status: 401 });
  }

  const { token, maxAge } = await createSessionToken(username, !!body.rememberMe);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  });
  return response;
}
