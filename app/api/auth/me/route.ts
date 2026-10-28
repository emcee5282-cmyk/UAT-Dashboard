import { NextRequest, NextResponse } from 'next/server';
import { getRequestSession } from '@/app/lib/auth/guard';

export async function GET(request: NextRequest) {
  const session = await getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
  });
}
