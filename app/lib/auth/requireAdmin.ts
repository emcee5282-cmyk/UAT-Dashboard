// Settings-only gate for API routes (Discrepancy/Unreconciled TG config).
// Thin wrapper over the permissions table so "admin" is defined in exactly
// one place (app/lib/auth/permissions.ts -> settings.manage).
import type { NextRequest } from 'next/server';
import { getRequestSession } from './guard';
import { can, type Permission } from './permissions';
import type { SessionPayload } from './session';

export async function requireAdmin(request: NextRequest): Promise<SessionPayload | null> {
  return requirePermission(request, 'settings.manage');
}

export async function requirePermission(request: NextRequest, permission: Permission): Promise<SessionPayload | null> {
  const session = await getRequestSession(request);
  if (!session || session.mustChangePassword || !can(session.permissions, permission)) return null;
  return session;
}
