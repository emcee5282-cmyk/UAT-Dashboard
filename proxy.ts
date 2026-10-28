// Gate for every page and API request. All access decisions come from
// app/lib/auth/permissions.ts — this file only applies them. Each API
// handler re-checks the same table itself (app/lib/auth/guard.ts), so this
// is the first line of defense, not the only one.
//
// Next 16 "Proxy" (formerly Middleware) runs on the Node.js runtime, which
// is what lets it validate sessions against Postgres on every request.
import { NextRequest, NextResponse } from 'next/server';
import { BACKGROUND_REQUEST_HEADER, SESSION_COOKIE_NAME, verifySessionToken } from '@/app/lib/auth/session';
import {
  ACCOUNT_API_PATHS,
  ACCOUNT_PAGES,
  PUBLIC_API_PATHS,
  PUBLIC_PAGES,
  SECRET_API_PREFIXES,
  apiPermissions,
  canAny,
  canOpenPage,
  homePathFor,
  isWriteMethod,
} from '@/app/lib/auth/permissions';

function json(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Cross-site request guard for state-changing API calls (on top of
// SameSite=Lax): a browser always sends Origin on a cross-origin POST, so
// one that doesn't match this host is rejected. Requests without Origin
// (curl, server-to-server, the scheduler) pass — they can't carry a
// victim's cookie anyway.
function isCrossSiteWrite(request: NextRequest): boolean {
  if (!isWriteMethod(request.method)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (isApi && isCrossSiteWrite(request)) return json(403, 'Forbidden');

  if (isApi && PUBLIC_API_PATHS.includes(pathname)) return NextResponse.next();

  // Shared-secret machine routes (VPS cron). Each one validates its own
  // Bearer secret and fails closed without it. /api/cron/* is secret-only;
  // the /api/admin sync/rollover routes also accept a system-account
  // session (handled by the normal flow below) when no Bearer is sent.
  if (isApi && SECRET_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (pathname.startsWith('/api/cron/') || request.headers.get('authorization')?.startsWith('Bearer ')) {
      return NextResponse.next();
    }
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, {
    countAsActivity: request.headers.get(BACKGROUND_REQUEST_HEADER) !== '1',
  });

  if (PUBLIC_PAGES.includes(pathname)) {
    if (session) {
      const target = session.mustChangePassword ? '/change-password' : homePathFor(session.permissions);
      return NextResponse.redirect(new URL(target, request.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    const response = isApi ? json(401, 'Unauthorized') : NextResponse.redirect(new URL('/login', request.url));
    // Drop a dead (expired/idle/revoked) cookie so the browser stops sending it.
    if (request.cookies.has(SESSION_COOKIE_NAME)) response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  const isAccountPath = isApi ? ACCOUNT_API_PATHS.includes(pathname) : ACCOUNT_PAGES.includes(pathname);

  // First login / admin reset: nothing but the change-password flow until done.
  if (session.mustChangePassword && !isAccountPath) {
    return isApi ? json(403, 'Password change required') : NextResponse.redirect(new URL('/change-password', request.url));
  }

  if (!isAccountPath) {
    if (isApi) {
      if (!canAny(session.permissions, apiPermissions(pathname, request.method))) return json(403, 'Forbidden');
    } else if (!canOpenPage(session.permissions, pathname)) {
      return NextResponse.redirect(new URL(homePathFor(session.permissions), request.url));
    }
  }

  const response = NextResponse.next();
  // Authenticated page responses must never be served from the browser's
  // back-forward cache — without this, pressing Back after Logout can
  // briefly redisplay the dashboard's last rendered state (a stale bfcache
  // snapshot, not a real request this proxy ever sees) before its data
  // fetches fail. no-store forces a real request every time.
  if (!isApi) response.headers.set('Cache-Control', 'no-store, must-revalidate');
  return response;
}

export const config = {
  // Everything except Next's own static/image internals, favicon, and real
  // public/ static assets (logos, download templates) — this intentionally
  // still includes API routes and every page route, not just a hand-picked
  // subset, so nothing is ever accidentally left ungated.
  //
  // The static-asset exclusion isn't just about not gating logos behind
  // login — next/image's own optimizer (/_next/image) fetches originals via
  // an internal, cookieless sub-request. Without this exclusion, that
  // sub-request always looked like an unauthenticated page load and got
  // redirected to /login, so every optimized <Image> of a public/ file
  // silently failed (found 2026-08-19: all 4 Wallet Breakdown logos
  // rendering as plain letter badges instead of the real PNGs). Root-level
  // public/*.svg is excluded for the same reason — the login page's own
  // logo is one, and it must load while signed out.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|wallets/|templates/|[^/]+\\.svg$).*)'],
};
