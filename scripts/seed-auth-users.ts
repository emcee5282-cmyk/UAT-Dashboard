// Seeds the two accounts needed to test real DB-backed auth + the upcoming
// ticket creation flow: the existing admin/admin123 dev login (now a real
// users row instead of the hardcoded string comparison it used to be) and
// a leader-role test account linked to a real leaders row, so "scope to
// the logged-in leader's shop pool" has real agents to scope against.
//
// Idempotent — safe to re-run; on conflict it just reports the existing
// row instead of erroring or creating a duplicate.
//
// Run with: npx tsx --env-file=.env.local scripts/seed-auth-users.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import { users, leaders } from '../app/lib/db/schema';
import { hashPassword } from '../app/lib/auth/password';

async function upsertUser(params: { username: string; password: string; name: string; role: string; leaderId: number | null }) {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.username, params.username)).limit(1);
  if (existing) {
    console.log(`- ${params.username}: already exists (id=${existing.id}, role=${existing.role}), left unchanged`);
    return existing;
  }
  const passwordHash = await hashPassword(params.password);
  const [created] = await db
    .insert(users)
    .values({ username: params.username, passwordHash, name: params.name, role: params.role, leaderId: params.leaderId })
    .returning();
  console.log(`- ${params.username}: created (id=${created.id}, role=${created.role})`);
  return created;
}

async function main() {
  const db = getDb();

  await upsertUser({ username: 'admin', password: 'admin123', name: 'Admin', role: 'admin', leaderId: null });

  // Picks the first leader row (by id) that actually has agents under it —
  // an arbitrary but real choice, so the leader-role test account's "shop
  // pool" isn't empty the first time someone tries Shop replacement.
  const [testLeader] = await db.select().from(leaders).orderBy(leaders.id).limit(1);
  if (!testLeader) {
    throw new Error('No rows in leaders — cannot create a leader-role test account without a real leader to link it to.');
  }
  await upsertUser({
    username: 'leader.test',
    password: 'leader123',
    name: `Leader Test (${testLeader.name})`,
    role: 'leader',
    leaderId: testLeader.id,
  });

  await upsertUser({ username: 'staff.test', password: 'staff123', name: 'Staff Test', role: 'staff', leaderId: null });

  console.log(`\nLeader test account is linked to leaders.id=${testLeader.id} ("${testLeader.name}").`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
