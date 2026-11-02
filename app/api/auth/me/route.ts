import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { getRequestSession } from '@/app/lib/auth/guard';

export async function GET(request: NextRequest) {
  const session = await getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The profile photo is read here only — not in the per-request session
  // lookup, so the (up to 200KB) image isn't loaded on every API call.
  const [row] = await getDb().select({ avatar: users.avatar }).from(users).where(eq(users.id, session.userId)).limit(1);
  // Just the fields callers actually need — the session token never leaves
  // the server. `permissions` (read live from the user's role) drives the
  // UI's useCan(); hiding buttons is a convenience only, every API route
  // re-checks server-side.
  return NextResponse.json({
    username: session.username,
    name: session.name,
    role: session.role,
    roleLabel: session.roleName,
    permissions: session.permissions,
    mustChangePassword: session.mustChangePassword,
    avatar: row?.avatar ?? null,
  });
}
