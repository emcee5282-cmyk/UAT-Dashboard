import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { getRequestSession } from '@/app/lib/auth/guard';
import { hashPassword, validatePasswordRules, verifyPassword } from '@/app/lib/auth/password';
import { revokeUserSessions } from '@/app/lib/auth/session';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';
import { homePathFor } from '@/app/lib/auth/permissions';

// Open to every signed-in user, including one held on /change-password by
// mustChangePassword (proxy.ts lets this path through for exactly that).
export async function POST(request: NextRequest) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    return NextResponse.json({ error: 'All fields are required.' }, { status: 400 });
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: 'New passwords do not match.', field: 'confirmPassword' }, { status: 400 });
  }
  const ruleError = validatePasswordRules(newPassword);
  if (ruleError) return NextResponse.json({ error: ruleError, field: 'newPassword' }, { status: 400 });

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: 'Current password is incorrect.', field: 'currentPassword' }, { status: 400 });
  }
  // The current hash IS the temporary password while mustChangePassword is
  // set, so this one check covers "cannot reuse the temporary password".
  if (await verifyPassword(newPassword, user.passwordHash)) {
    return NextResponse.json(
      { error: 'New password must be different from your current/temporary password.', field: 'newPassword' },
      { status: 400 }
    );
  }

  const now = new Date();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: now, updatedAt: now })
    .where(eq(users.id, user.id));
  // Everywhere else is signed out; this device stays signed in.
  await revokeUserSessions(user.id, session.sessionId);
  await logAudit({
    event: 'password_changed',
    actorUserId: user.id,
    targetUserId: user.id,
    meta: requestMeta(request),
    details: { wasForced: user.mustChangePassword },
  });

  return NextResponse.json({ ok: true, redirectTo: homePathFor(session.permissions) });
}
