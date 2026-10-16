// Shared admin-only gate for API routes — same verifySessionToken/
// SESSION_COOKIE_NAME pattern as app/api/tickets/*, extracted once it was
// about to be duplicated a third time (Settings > Discrepancy TG's own
// route, plus the "Send to TG" preview/send routes).
import type { NextRequest } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME, type SessionPayload } from './session';

export async function requireAdmin(request: NextRequest): Promise<SessionPayload | null> {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || session.role !== 'admin') return null;
  return session;
}
