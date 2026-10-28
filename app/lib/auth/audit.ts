import { getDb } from '@/app/lib/db/client';
import { authAuditLog } from '@/app/lib/db/schema';

export type AuditEvent =
  | 'login_success'
  | 'login_failed'
  | 'login_locked' // the attempt that tripped the lockout
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'user_created'
  | 'user_edited'
  | 'role_changed'
  | 'user_deactivated'
  | 'user_reactivated'
  | 'user_unlocked'
  | 'role_created'
  | 'role_updated'
  | 'role_deleted';

export type RequestMeta = { ip: string | null; userAgent: string | null };

// First hop of X-Forwarded-For (nginx on the VPS / Vercel's edge both set
// it); falls back to X-Real-IP. Only used for the audit trail.
export function requestMeta(request: Request): RequestMeta {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
  return { ip, userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null };
}

// Never pass a password (plain or hashed) in `details` — it's shown as-is
// to admins. Audit failures are logged and swallowed: a broken audit insert
// must never block a login or lock someone out.
export async function logAudit(entry: {
  event: AuditEvent;
  actorUserId?: number | null;
  targetUserId?: number | null;
  usernameAttempted?: string | null;
  meta: RequestMeta;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getDb()
      .insert(authAuditLog)
      .values({
        event: entry.event,
        actorUserId: entry.actorUserId ?? null,
        targetUserId: entry.targetUserId ?? null,
        usernameAttempted: entry.usernameAttempted?.slice(0, 100) ?? null,
        ip: entry.meta.ip,
        userAgent: entry.meta.userAgent,
        details: entry.details ?? null,
      });
  } catch (err) {
    console.error('[auth audit] insert failed:', entry.event, err instanceof Error ? err.message : err);
  }
}
