import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { authorizeApi } from '@/app/lib/auth/guard';
import { ADMIN_ROLE, needsLeaderLink, normalizeRoleKey } from '@/app/lib/auth/permissions';
import { hashPassword } from '@/app/lib/auth/password';
import { isKnownTeam } from '@/app/lib/auth/teams';
import { logAudit, requestMeta } from '@/app/lib/auth/audit';
import { isAssignableRole, listRoles, storedPermissionsFor } from '@/app/lib/auth/roles';
import { USERNAME_PATTERN, USERNAME_RULE, cleanText, leaderExists, listLeaders, listUsers } from '@/app/lib/auth/userAdmin';

// User Management (users.manage in permissions.ts). Only an Admin may see,
// create or assign the Admin role — users.manage alone stops at non-Admins. Also
// returns the role list (role tabs + the Add/Edit dropdown come from the DB).
export async function GET(request: NextRequest) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const [userRows, leaderRows, roleRows] = await Promise.all([listUsers(), listLeaders(), listRoles()]);
  return NextResponse.json(
    {
      users: userRows,
      leaders: leaderRows,
      roles: roleRows
        .filter((r) => r.key !== ADMIN_ROLE || normalizeRoleKey(auth.session.role) === ADMIN_ROLE)
        .map((r) => ({ key: r.key, name: r.name, needsLeader: needsLeaderLink(r.permissions) })),
      currentUserId: auth.session.userId,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// Create: the first-login password is the username itself (stored hashed
// like any password). mustChangePassword holds the account on
// /change-password until the user sets their own — the proxy and every API
// route enforce that, it can't be skipped.
export async function POST(request: NextRequest) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const name = cleanText(body.name);
  const team = cleanText(body.team, 60);
  const role = typeof body.role === 'string' ? body.role : '';
  const leaderId = body.leaderId == null || body.leaderId === '' ? null : Number(body.leaderId);

  if (!USERNAME_PATTERN.test(username)) return NextResponse.json({ error: `Username: ${USERNAME_RULE}`, field: 'username' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Display name is required.', field: 'name' }, { status: 400 });
  if (team && !isKnownTeam(team)) return NextResponse.json({ error: 'Pick a team from the list.', field: 'team' }, { status: 400 });
  if (!(await isAssignableRole(role))) return NextResponse.json({ error: 'Pick a valid role.', field: 'role' }, { status: 400 });
  if (role === ADMIN_ROLE && normalizeRoleKey(auth.session.role) !== ADMIN_ROLE) {
    return NextResponse.json({ error: 'Only an Admin can create Admin accounts.', field: 'role' }, { status: 403 });
  }
  const needsLeader = needsLeaderLink(await storedPermissionsFor(role));
  if (needsLeader && (!leaderId || !Number.isInteger(leaderId) || !(await leaderExists(leaderId)))) {
    return NextResponse.json({ error: 'This role raises tickets, so the account must be linked to a leader name.', field: 'leaderId' }, { status: 400 });
  }

  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${username}`).limit(1);
  if (existing) return NextResponse.json({ error: 'That username is already taken.', field: 'username' }, { status: 409 });

  const tempPassword = username; // first-login password = username
  const [created] = await db
    .insert(users)
    .values({
      username,
      name,
      team,
      role,
      leaderId: needsLeader ? leaderId : null,
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
      status: 'active',
    })
    .returning({ id: users.id });

  await logAudit({
    event: 'user_created',
    actorUserId: auth.session.userId,
    targetUserId: created.id,
    meta: requestMeta(request),
    details: { username, role, team, leaderId: needsLeader ? leaderId : null },
  });

  return NextResponse.json({ ok: true, userId: created.id, username, tempPassword }, { headers: { 'Cache-Control': 'no-store' } });
}
