// One-off cleanup of the pre-existing accounts that had known/weak
// passwords (from the old seed script), approved 2026-10-28:
//   - admin       -> must change password at next login (only while it
//                    still has its old password — once its password has
//                    been changed, password_changed_at is set and re-runs
//                    leave it alone)
//   - staff.test  -> deactivated (kept, never deleted — audit history)
//   - extra usernames passed as --deactivate=a,b to deactivate too (the
//     leader.* test accounts, once confirmed which are test-only)
// Every change is written to auth_audit_log. Idempotent.
//
// Run with: npx tsx --env-file=.env.local scripts/_apply-auth-account-hardening.ts [--deactivate=leader.zerotest,...]
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import { users } from '../app/lib/db/schema';
import { revokeUserSessions } from '../app/lib/auth/session';
import { logAudit } from '../app/lib/auth/audit';

const META = { ip: null, userAgent: 'scripts/_apply-auth-account-hardening.ts' };

async function main() {
  const db = getDb();
  const extra = (process.argv.find((a) => a.startsWith('--deactivate='))?.split('=')[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const toDeactivate = ['staff.test', ...extra];

  const forced = await db
    .update(users)
    .set({ mustChangePassword: true, updatedAt: new Date() })
    .where(and(eq(users.username, 'admin'), eq(users.mustChangePassword, false), isNull(users.passwordChangedAt)))
    .returning({ id: users.id, username: users.username });
  for (const u of forced) {
    await revokeUserSessions(u.id);
    await logAudit({ event: 'user_edited', targetUserId: u.id, meta: META, details: { mustChangePassword: { from: false, to: true } } });
    console.log(`- ${u.username}: must change password at next login`);
  }

  const deactivated = await db
    .update(users)
    .set({ status: 'deactivated', updatedAt: new Date() })
    .where(and(inArray(users.username, toDeactivate), ne(users.status, 'deactivated')))
    .returning({ id: users.id, username: users.username });
  for (const u of deactivated) {
    await revokeUserSessions(u.id);
    await logAudit({ event: 'user_deactivated', targetUserId: u.id, meta: META });
    console.log(`- ${u.username}: deactivated`);
  }

  if (forced.length + deactivated.length === 0) console.log('Nothing to change (already applied).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
