// Shared bits for the User Management API routes (app/api/admin/users/*).
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { leaders, roles, users } from '@/app/lib/db/schema';
import { SYSTEM_ROLE, normalizeRoleKey } from './permissions';

export type UserStatus = 'Active' | 'Locked' | 'Deactivated';

export type AdminUserRow = {
  id: number;
  username: string;
  name: string | null;
  role: string;
  roleLabel: string;
  team: string | null;
  leaderId: number | null;
  leaderName: string | null;
  status: UserStatus;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  avatar: string | null; // profile photo data URL (see PATCH /api/me/avatar)
};

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
export const USERNAME_RULE = '3-40 characters: lowercase letters, numbers, dot, dash or underscore.';

export function deriveStatus(u: { status: string; lockedUntil: Date | null }): UserStatus {
  if (u.status !== 'active') return 'Deactivated';
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) return 'Locked';
  return 'Active';
}

// System (scheduler) accounts are hidden from User Management entirely.
export async function listUsers(): Promise<AdminUserRow[]> {
  const db = getDb();
  const [rows, roleRows] = await Promise.all([
    db.select({ user: users, leaderName: leaders.name }).from(users).leftJoin(leaders, eq(users.leaderId, leaders.id)).orderBy(asc(users.username)),
    db.select({ key: roles.key, name: roles.name }).from(roles),
  ]);
  const roleName = new Map(roleRows.map((r) => [r.key, r.name]));
  return rows
    .filter(({ user: u }) => normalizeRoleKey(u.role) !== SYSTEM_ROLE)
    .map(({ user: u, leaderName }) => {
    const role = normalizeRoleKey(u.role);
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      role,
      roleLabel: roleName.get(role) ?? u.role,
      team: u.team,
      leaderId: u.leaderId,
      leaderName,
      status: deriveStatus(u),
      lockedUntil: u.lockedUntil?.toISOString() ?? null,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      avatar: u.avatar ?? null,
    };
  });
}

export async function listLeaders(): Promise<{ id: number; name: string }[]> {
  return getDb().select({ id: leaders.id, name: leaders.name }).from(leaders).orderBy(asc(leaders.name));
}

export async function leaderExists(id: number): Promise<boolean> {
  const [row] = await getDb().select({ id: leaders.id }).from(leaders).where(eq(leaders.id, id)).limit(1);
  return !!row;
}

export function cleanText(value: unknown, max = 100): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}
