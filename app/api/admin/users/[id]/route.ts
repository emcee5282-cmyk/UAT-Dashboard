import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { authorizeApi } from '@/app/lib/auth/guard';
import { SYSTEM_ROLE, needsLeaderLink, normalizeRoleKey } from '@/app/lib/auth/permissions';
import { isAssignableRole, storedPermissionsFor } from '@/app/lib/auth/roles';
import { generateTempPassword, hashPassword } from '@/app/lib/auth/password';
import { revokeUserSessions } from '@/app/lib/auth/session';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';
import { cleanText, leaderExists } from '@/app/lib/auth/userAdmin';

type Action = 'update' | 'reset_password' | 'unlock' | 'deactivate' | 'reactivate';
const ACTIONS: Action[] = ['update', 'reset_password', 'unlock', 'deactivate', 'reactivate'];

// One PATCH per row action from User Management. Users are never deleted —
// "deactivate" is the removal path, so audit history keeps its references.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const actorId = auth.session.userId;
  const meta = requestMeta(request);

  const targetId = Number((await params).id);
  if (!Number.isInteger(targetId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const action = body.action as Action;
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isSelf = target.id === actorId;
  // The scheduler's service account is hidden from User Management.
  if (normalizeRoleKey(target.role) === SYSTEM_ROLE) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const now = new Date();

  if (action === 'update') {
    const name = cleanText(body.name);
    const team = cleanText(body.team, 60);
    const currentRole = normalizeRoleKey(target.role);
    const role = typeof body.role === 'string' ? body.role : currentRole;
    const leaderId = body.leaderId == null || body.leaderId === '' ? null : Number(body.leaderId);

    if (!name) return NextResponse.json({ error: 'Display name is required.', field: 'name' }, { status: 400 });
    if (role !== currentRole && !(await isAssignableRole(role))) {
      return NextResponse.json({ error: 'Pick a valid role.', field: 'role' }, { status: 400 });
    }
    if (isSelf && role !== currentRole) {
      return NextResponse.json({ error: 'You cannot change your own role.', field: 'role' }, { status: 400 });
    }
    const needsLeader = needsLeaderLink(await storedPermissionsFor(role));
    if (needsLeader && (!leaderId || !Number.isInteger(leaderId) || !(await leaderExists(leaderId)))) {
      return NextResponse.json({ error: 'This role raises tickets, so the account must be linked to a leader name.', field: 'leaderId' }, { status: 400 });
    }

    const nextLeaderId = needsLeader ? leaderId : null;
    await db.update(users).set({ name, team, role, leaderId: nextLeaderId, updatedAt: now }).where(eq(users.id, targetId));

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (name !== target.name) changes.name = { from: target.name, to: name };
    if (team !== target.team) changes.team = { from: target.team, to: team };
    if (nextLeaderId !== target.leaderId) changes.leaderId = { from: target.leaderId, to: nextLeaderId };
    if (Object.keys(changes).length > 0) {
      await logAudit({ event: 'user_edited', actorUserId: actorId, targetUserId: targetId, meta, details: changes });
    }
    if (role !== currentRole) {
      await logAudit({ event: 'role_changed', actorUserId: actorId, targetUserId: targetId, meta, details: { from: target.role, to: role } });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === 'reset_password') {
    if (isSelf) {
      return NextResponse.json({ error: 'Use Change password for your own account.' }, { status: 400 });
    }
    const tempPassword = generateTempPassword();
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, targetId));
    await revokeUserSessions(targetId);
    await logAudit({ event: 'password_reset', actorUserId: actorId, targetUserId: targetId, meta });
    return NextResponse.json({ ok: true, username: target.username, tempPassword }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'unlock') {
    await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, targetId));
    await logAudit({ event: 'user_unlocked', actorUserId: actorId, targetUserId: targetId, meta });
    return NextResponse.json({ ok: true });
  }

  if (action === 'deactivate') {
    if (isSelf) return NextResponse.json({ error: 'You cannot deactivate your own account.' }, { status: 400 });
    await db.update(users).set({ status: 'deactivated', updatedAt: now }).where(eq(users.id, targetId));
    await revokeUserSessions(targetId);
    await logAudit({ event: 'user_deactivated', actorUserId: actorId, targetUserId: targetId, meta });
    return NextResponse.json({ ok: true });
  }

  // reactivate
  await db
    .update(users)
    .set({ status: 'active', failedLoginCount: 0, lockedUntil: null, updatedAt: now })
    .where(eq(users.id, targetId));
  await logAudit({ event: 'user_reactivated', actorUserId: actorId, targetUserId: targetId, meta });
  return NextResponse.json({ ok: true });
}
