import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

const PUBLIC_PAGE_PATHS = ['/login'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The login API itself is never gated (that would be a lock — the login
  // page couldn't ever call it to establish a session).
  if (pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const isPublicPage = PUBLIC_PAGE_PATHS.includes(pathname);

  if (!session && !isPublicPage) {
    // API routes get a plain 401 (callers expect JSON, not an HTML
    // redirect); real pages get sent to the login screen.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (session && isPublicPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const response = NextResponse.next();
  // Authenticated page responses must never be served from the browser's
  // back-forward cache — without this, pressing Back after Logout can
  // briefly redisplay the dashboard's last rendered state (a stale bfcache
  // snapshot, not a real request middleware ever sees) before its data
  // fetches fail. no-store forces a real request every time.
  if (session && !pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store, must-revalidate');
  }
  return response;
}

export const config = {
  // Everything except Next's own static/image internals and favicon — this
  // intentionally includes API routes and every page route, not just a
  // hand-picked subset, so nothing is ever accidentally left ungated.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
