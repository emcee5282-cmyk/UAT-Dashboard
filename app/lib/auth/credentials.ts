import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from './password';
import { logAudit, type RequestMeta } from './audit';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export type VerifiedUser = {
  id: number;
  username: string;
  name: string | null;
  role: string;
  leaderId: number | null;
  mustChangePassword: boolean;
};

// Every failure path returns null, and the login route turns that into the
// same "Invalid username or password" — unknown user, wrong password,
// deactivated and locked are indistinguishable to the caller (and take the
// same time, via burnPasswordCheck). The real reason goes to the audit log.
export async function verifyCredentials(username: string, password: string, meta: RequestMeta): Promise<VerifiedUser | null> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);

  if (!user) {
    await burnPasswordCheck(password);
    await logAudit({ event: 'login_failed', usernameAttempted: username, meta, details: { reason: 'unknown_user' } });
    return null;
  }

  const now = Date.now();
  if (user.status !== 'active' || (user.lockedUntil && user.lockedUntil.getTime() > now)) {
    await burnPasswordCheck(password);
    const reason = user.status !== 'active' ? 'deactivated' : 'locked';
    await logAudit({ event: 'login_failed', targetUserId: user.id, usernameAttempted: username, meta, details: { reason } });
    return null;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const [updated] = await db
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, user.id))
      .returning({ failedLoginCount: users.failedLoginCount });
    if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      // Counter resets as the lock starts, so after the 15 minutes the user
      // gets a fresh 5 attempts.
      await db
        .update(users)
        .set({ lockedUntil: new Date(now + LOCKOUT_MS), failedLoginCount: 0 })
        .where(eq(users.id, user.id));
      await logAudit({
        event: 'login_locked',
        targetUserId: user.id,
        usernameAttempted: username,
        meta,
        details: { reason: 'too_many_failures', lockedMinutes: LOCKOUT_MS / 60000 },
      });
    } else {
      await logAudit({
        event: 'login_failed',
        targetUserId: user.id,
        usernameAttempted: username,
        meta,
        details: { reason: 'wrong_password', attempt: updated.failedLoginCount },
      });
    }
    return null;
  }

  await db
    .update(users)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(now),
      // Transparent upgrade of pre-argon2 hashes (see password.ts).
      ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
    })
    .where(eq(users.id, user.id));

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    leaderId: user.leaderId,
    mustChangePassword: user.mustChangePassword,
  };
}
