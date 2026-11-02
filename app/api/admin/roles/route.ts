import { NextRequest, NextResponse } from 'next/server';
import { authorizeApi } from '@/app/lib/auth/guard';
import { createRole, listRoles, RoleError } from '@/app/lib/auth/roles';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';

// Users → Roles (roles.manage — grantable from the Roles screen; the Admin
// role itself stays locked). GET is also what the Role editor's Copy-from and
// the Roles table read.
export async function GET(request: NextRequest) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ roles: await listRoles() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    const { role, after } = await createRole(body, auth.session.userId);
    await logAudit({
      event: 'role_created',
      actorUserId: auth.session.userId,
      meta: requestMeta(request),
      details: { roleId: role.id, roleKey: role.key, before: null, after },
    });
    return NextResponse.json({ ok: true, id: role.id, key: role.key });
  } catch (err) {
    if (err instanceof RoleError) return NextResponse.json({ error: err.message, field: err.field }, { status: err.status });
    throw err;
  }
}
