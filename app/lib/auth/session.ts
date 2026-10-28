// Server-side sessions backed by the `sessions` table. The cookie holds a
// random 256-bit token; only its SHA-256 is stored, so a DB leak can't be
// replayed. Every request re-reads the session + user row, which is what
// makes these work (none were possible with the old self-contained signed
// cookie):
//   - 12h absolute lifetime and 2h idle timeout, enforced server-side
//   - logout / password change / admin reset revoke sessions immediately
//   - role changes, role-permission edits (Users → Roles) and deactivation
//     take effect on the very next request — the role's permissions are
//     read in this same query, never cached
//
// Node runtime only — proxy.ts runs on Node in Next 16 (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
import { createHash, randomBytes } from 'crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { sessions, users } from '@/app/lib/db/schema';
import { effectivePermissions, normalizeRoleKey, type Permission } from './permissions';

export const SESSION_COOKIE_NAME = 'dashboard_session';

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
// lastActiveAt is only written when it's at least this stale — one UPDATE
// per minute per session at most, not one per request.
const TOUCH_THROTTLE_MS = 60 * 1000;

// Background polls don't count as activity (see backgroundPoll.ts).
export { BACKGROUND_REQUEST_HEADER } from './backgroundPoll';

export type SessionPayload = {
  sessionId: number;
  userId: number;
  username: string;
  name: string | null;
  // roles.key (legacy 'staff' comes back as 'ops').
  role: string;
  roleName: string;
  // Effective permissions (see effectivePermissions in permissions.ts).
  permissions: Permission[];
  leaderId: number | null;
  mustChangePassword: boolean;
  exp: number;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_ABSOLUTE_MS / 1000) {
  return {
    httpOnly: true,
    // Secure everywhere except plain-http localhost dev (browsers drop
    // Secure cookies set over http).
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function createSession(
  userId: number,
  meta: { ip: string | null; userAgent: string | null }
): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await getDb()
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      lastActiveAt: new Date(now),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    });
  return { token, maxAge: SESSION_ABSOLUTE_MS / 1000 };
}

// Kept under its old name so existing callers (ticket routes, telegram
// screenshot) didn't need rewriting. `countAsActivity: false` is for
// background polls (see BACKGROUND_REQUEST_HEADER).
export async function verifySessionToken(
  token: string | undefined | null,
  opts: { countAsActivity?: boolean } = {}
): Promise<SessionPayload | null> {
  if (!token || token.length > 200) return null;
  const db = getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastActiveAt: sessions.lastActiveAt,
      userId: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
      roleName: sql<string | null>`(select r.name from roles r where r.key = (case when ${users.role} = 'staff' then 'ops' else ${users.role} end))`,
      storedPermissions: sql<string[] | null>`(select array_agg(rp.permission) from role_permissions rp join roles r on r.id = rp.role_id where r.key = (case when ${users.role} = 'staff' then 'ops' else ${users.role} end))`,
      leaderId: users.leaderId,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
    .limit(1);
  if (!row) return null;

  const now = Date.now();
  const expired = row.expiresAt.getTime() <= now;
  const idle = now - row.lastActiveAt.getTime() >= SESSION_IDLE_MS;
  if (expired || idle || row.status !== 'active') {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, row.sessionId));
    return null;
  }

  if (opts.countAsActivity !== false && now - row.lastActiveAt.getTime() >= TOUCH_THROTTLE_MS) {
    await db.update(sessions).set({ lastActiveAt: new Date(now) }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    username: row.username,
    name: row.name,
    role: normalizeRoleKey(row.role),
    roleName: row.roleName ?? row.role,
    // A role missing from `roles` (deleted / typo) gets nothing.
    permissions: row.roleName == null ? [] : effectivePermissions(normalizeRoleKey(row.role), row.storedPermissions ?? []),
    leaderId: row.leaderId,
    mustChangePassword: row.mustChangePassword,
    exp: row.expiresAt.getTime(),
  };
}

export async function revokeSessionToken(token: string | undefined | null): Promise<number | null> {
  if (!token) return null;
  const [row] = await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
    .returning({ userId: sessions.userId });
  return row?.userId ?? null;
}

// Logs a user out everywhere — optionally keeping the session that made
// the change (a user changing their own password stays signed in on the
// device they did it from).
export async function revokeUserSessions(userId: number, exceptSessionId?: number): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : sql`true`
      )
    );
}
