import { NextRequest, NextResponse } from 'next/server';
import { authorizeApi } from '@/app/lib/auth/guard';
import { deleteRole, RoleError, updateRole } from '@/app/lib/auth/roles';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';

type Ctx = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  if (err instanceof RoleError) return NextResponse.json({ error: err.message, field: err.field }, { status: err.status });
  throw err;
}

// Edits apply on every affected user's next click: sessions read the
// role's permissions live (app/lib/auth/session.ts), nothing is cached.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
    const { role, before, after } = await updateRole(id, body, auth.session.userId);
    await logAudit({
      event: 'role_updated',
      actorUserId: auth.session.userId,
      meta: requestMeta(request),
      details: { roleId: id, roleKey: role.key, before, after },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { role, before } = await deleteRole(id);
    await logAudit({
      event: 'role_deleted',
      actorUserId: auth.session.userId,
      meta: requestMeta(request),
      details: { roleId: id, roleKey: role.key, before, after: null },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
