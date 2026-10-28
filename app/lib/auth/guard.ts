// Per-route server-side permission check. proxy.ts already blocks by the
// same rules, but every API handler calls this too, so a route stays
// protected even if the proxy matcher is ever misconfigured or bypassed.
//
// Usage at the top of a handler:
//   const auth = await authorizeApi(request);
//   if (auth instanceof NextResponse) return auth;
//   // auth.session is the signed-in user
import { NextResponse } from 'next/server';
import { actionPerm, apiPermissions, can, canAny, type PageId, type Permission } from './permissions';
import { BACKGROUND_REQUEST_HEADER, SESSION_COOKIE_NAME, verifySessionToken, type SessionPayload } from './session';

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function getRequestSession(request: Request): Promise<SessionPayload | null> {
  return verifySessionToken(readCookie(request, SESSION_COOKIE_NAME), {
    countAsActivity: request.headers.get(BACKGROUND_REQUEST_HEADER) !== '1',
  });
}

function deny(status: 401 | 403): NextResponse {
  return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status });
}

// Checks the request against permissions.ts's API table for its own path
// and method. Pass `anyOf` to require something narrower than the table.
export async function authorizeApi(
  request: Request,
  anyOf?: Permission[]
): Promise<{ session: SessionPayload } | NextResponse> {
  const session = await getRequestSession(request);
  if (!session) return deny(401);
  if (session.mustChangePassword) return NextResponse.json({ error: 'Password change required' }, { status: 403 });
  const { pathname } = new URL(request.url);
  const required = anyOf ?? apiPermissions(pathname, request.method);
  if (!canAny(session.permissions, required)) return deny(403);
  return { session };
}

// Single edit and bulk edit share one PATCH (an id list) on the record
// routes, so the proxy can't tell them apart — the handler calls this once
// it knows how many rows are being changed.
export function requireBulkEdit(session: SessionPayload, page: PageId, rowCount: number): NextResponse | null {
  if (rowCount <= 1 || can(session.permissions, actionPerm(page, 'bulkEdit'))) return null;
  return deny(403);
}
