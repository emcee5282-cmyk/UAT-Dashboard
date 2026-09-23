import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

const PUBLIC_PAGE_PATHS = ['/login'];

// The real, live /settings page (exact path only — /settings/demo is a
// separate sandbox route carrying the new account-menu/theme work and must
// stay behind the normal login gate below) plus the API routes it reads/
// writes, all deliberately left ungated so /settings renders exactly as it
// does in production, which has no auth system at all.
const PRODUCTION_PARITY_PAGE = '/settings';
const PRODUCTION_PARITY_API_PREFIX = '/api/configurations/transfer-queue-settings';

// The leader-facing ticketing pages (create, history list, detail/chat) —
// everything else in the dashboard is role-agnostic (any authenticated
// session), so this is an allowlist of the one area that additionally
// checks role. Deliberately does NOT include /api/tickets* — those routes
// now serve both leader and staff callers with different behavior per
// role, so the role check lives in each handler instead of here.
const LEADER_ONLY_PATH_PREFIXES = ['/tickets', '/api/agents/search'];
// The staff-facing ticket queue — now also reachable by admin (it lives
// inside the main dashboard nav, see Sidebar.tsx's "Tickets" entry), but
// still not leaders, who have their own separate standalone flow.
const STAFF_OR_ADMIN_ONLY_PATH_PREFIXES = ['/staff'];
// The full inverse: everywhere a LEADER is allowed. Leaders don't just get
// blocked from a couple of staff-only spots like everyone else — their
// account exists ONLY inside the ticket flow, so this is a strict
// allowlist checked the other direction (see the dedicated block below).
// /api/tickets* isn't in LEADER_ONLY_PATH_PREFIXES above (shared with
// staff/admin) but a leader still needs it — POST create, GET their own
// list/detail, POST messages.
const LEADER_ALLOWED_PATH_PREFIXES = ['/tickets', '/api/tickets', '/api/agents/search'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The login API itself is never gated (that would be a lock — the login
  // page couldn't ever call it to establish a session).
  if (pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (pathname === PRODUCTION_PARITY_PAGE || pathname.startsWith(PRODUCTION_PARITY_API_PREFIX)) {
    // The parity carve-out predates the leader role and was never meant to
    // exempt it — a leader's account exists ONLY inside the ticket flow
    // (see LEADER_ALLOWED_PATH_PREFIXES below), so typing /settings
    // directly must still bounce them, same as every other non-ticket
    // page. Everyone else (including a logged-out visitor) keeps the
    // no-auth parity behavior.
    if (session?.role === 'leader') {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.redirect(new URL('/tickets', request.url));
    }
    return NextResponse.next();
  }

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
    return NextResponse.redirect(new URL(session.role === 'leader' ? '/tickets' : '/', request.url));
  }

  // Leader lockdown: checked first (before the staff/admin block below)
  // specifically so a leader hitting e.g. /staff/tickets lands on /tickets,
  // never on '/' — that block's own redirect target is the main dashboard,
  // which a leader must never see even in transit.
  if (session && session.role === 'leader' && !LEADER_ALLOWED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.redirect(new URL('/tickets', request.url));
  }

  if (session && LEADER_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && session.role !== 'leader') {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.redirect(new URL('/', request.url));
  }

  if (
    session &&
    STAFF_OR_ADMIN_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    session.role !== 'staff' &&
    session.role !== 'admin'
  ) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
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
  // Everything except Next's own static/image internals, favicon, and real
  // public/ static assets (logos, download templates) — this intentionally
  // still includes API routes and every page route, not just a hand-picked
  // subset, so nothing is ever accidentally left ungated.
  //
  // The static-asset exclusion isn't just about not gating logos behind
  // login — next/image's own optimizer (/_next/image) fetches originals via
  // an internal, cookieless sub-request. Without this exclusion, that
  // sub-request always looked like an unauthenticated page load to this
  // middleware and got redirected to /login, so every optimized <Image> of
  // a public/ file silently failed and fell back to its error state (found
  // 2026-08-19: all 4 Wallet Breakdown logos rendering as plain letter
  // badges instead of the real PNGs).
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|wallets/|templates/).*)'],
};
