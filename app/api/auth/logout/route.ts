import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  // maxAge: 0 tells the browser to drop the cookie immediately — the
  // signed token itself becomes irrelevant since nothing sends it anymore.
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
