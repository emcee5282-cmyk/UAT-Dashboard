// Roles data access for Users → Roles (server only). The permission strings
// stored here are validated against the catalog in permissions.ts; Admin
// (locked) and System (hidden) can never be changed through these functions.
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { rolePermissions, roles, users } from '@/app/lib/db/schema';
import { ADMIN_ROLE, ROLE_ALIASES, SYSTEM_ROLE, effectivePermissions, isGrantable, type Permission } from './permissions';

export type RoleRow = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  locked: boolean;
  userCount: number;
  // Effective (what the role can actually do — Admin shows everything).
  permissions: Permission[];
  updatedAt: string;
  updatedByName: string | null;
};

export class RoleError extends Error {
  constructor(
    message: string,
    public status = 400,
    public field?: string
  ) {
    super(message);
  }
}

// users.role values that count as this role (legacy aliases included).
function keysFor(roleKey: string): string[] {
  return [roleKey, ...Object.entries(ROLE_ALIASES).filter(([, to]) => to === roleKey).map(([from]) => from)];
}

// Visible roles only — System is never listed.
export async function listRoles(): Promise<RoleRow[]> {
  const db = getDb();
  const [roleRows, perms, counts] = await Promise.all([
    db
      .select({ role: roles, updatedByName: sql<string | null>`(select coalesce(u.name, u.username) from users u where u.id = ${roles.updatedBy})` })
      .from(roles)
      .where(eq(roles.hidden, false))
      .orderBy(asc(roles.id)),
    db.select().from(rolePermissions),
    db.select({ role: users.role, n: sql<number>`count(*)::int` }).from(users).groupBy(users.role),
  ]);
  return roleRows.map(({ role: r, updatedByName }) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    locked: r.locked || r.key === ADMIN_ROLE,
    userCount: counts.filter((c) => keysFor(r.key).includes(c.role.toLowerCase())).reduce((s, c) => s + c.n, 0),
    permissions: effectivePermissions(r.key, perms.filter((p) => p.roleId === r.id).map((p) => p.permission)),
    updatedAt: r.updatedAt.toISOString(),
    updatedByName,
  }));
}

export async function roleByKey(key: string) {
  const [row] = await getDb().select().from(roles).where(eq(roles.key, key)).limit(1);
  return row ?? null;
}

// Roles a user can be given on User Management (never System).
export async function isAssignableRole(key: string): Promise<boolean> {
  const row = await roleByKey(key);
  return !!row && !row.hidden && row.key !== SYSTEM_ROLE;
}

export async function storedPermissionsFor(roleKey: string): Promise<Permission[]> {
  const row = await roleByKey(roleKey);
  if (!row) return [];
  const perms = await getDb().select().from(rolePermissions).where(eq(rolePermissions.roleId, row.id));
  return effectivePermissions(row.key, perms.map((p) => p.permission));
}

function cleanPermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) throw new RoleError('Permissions must be a list.');
  const bad = input.filter((p) => typeof p !== 'string' || !isGrantable(p));
  if (bad.length > 0) throw new RoleError(`Unknown or non-grantable permission: ${String(bad[0])}`);
  // Store the effective set (edit implies view, settle implies view) so the
  // matrix always reloads exactly as it'll behave.
  return effectivePermissions('custom', input as string[]).sort();
}

function cleanName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 40) throw new RoleError('Role name must be 2-40 characters.', 400, 'name');
  return name;
}

function cleanDescription(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return input.trim().slice(0, 200) || null;
}

function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'role';
}

async function assertNameFree(name: string, exceptId?: number) {
  const [clash] = await getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(sql`lower(${roles.name}) = lower(${name})`)
    .limit(1);
  if (clash && clash.id !== exceptId) throw new RoleError('A role with that name already exists.', 409, 'name');
}

export async function createRole(input: { name: unknown; description: unknown; permissions: unknown }, actorId: number) {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const permissions = cleanPermissions(input.permissions);
  await assertNameFree(name);

  const db = getDb();
  // Stable key: slug of the first name, suffixed if taken (keys never change
  // after creation, so renaming later is safe for users.role).
  let key = slugFor(name);
  for (let i = 2; await roleByKey(key); i++) key = `${slugFor(name)}_${i}`;

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(roles).values({ key, name, description, updatedBy: actorId }).returning();
    if (permissions.length) await tx.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: row.id, permission })));
    return { role: row, after: { name, description, permissions } };
  });
}

export async function updateRole(id: number, input: { name: unknown; description: unknown; permissions: unknown }, actorId: number) {
  const db = getDb();
  const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!row || row.hidden || row.key === SYSTEM_ROLE) throw new RoleError('Role not found.', 404);
  if (row.locked || row.key === ADMIN_ROLE) throw new RoleError('The Admin role is locked and cannot be edited.', 403);

  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const permissions = cleanPermissions(input.permissions);
  await assertNameFree(name, id);

  const beforePerms = (await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, id))).map((p) => p.permission).sort();
  await db.transaction(async (tx) => {
    await tx.update(roles).set({ name, description, updatedAt: new Date(), updatedBy: actorId }).where(eq(roles.id, id));
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    if (permissions.length) await tx.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: id, permission })));
  });
  return {
    role: row,
    before: { name: row.name, description: row.description, permissions: beforePerms },
    after: { name, description, permissions },
  };
}

export async function deleteRole(id: number) {
  const db = getDb();
  const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!row || row.hidden || row.key === SYSTEM_ROLE) throw new RoleError('Role not found.', 404);
  if (row.locked || row.key === ADMIN_ROLE) throw new RoleError('The Admin role is locked and cannot be deleted.', 403);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`lower(${users.role}) in (${sql.join(keysFor(row.key).map((k) => sql`${k}`), sql`, `)})`);
  if (n > 0) throw new RoleError(`${n} user${n === 1 ? ' still has' : 's still have'} this role. Move them to another role first.`, 409);
  const beforePerms = (await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, id))).map((p) => p.permission).sort();
  await db.delete(roles).where(and(eq(roles.id, id), eq(roles.locked, false)));
  return { role: row, before: { name: row.name, description: row.description, permissions: beforePerms } };
}
