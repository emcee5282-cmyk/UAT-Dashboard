// Seeds the test accounts used to exercise the ticket flow locally: a
// leader-role account linked to a real leaders row (so "scope to the
// logged-in leader's shop pool" has real agents) and an OPS account.
//
// No passwords live in this file: each newly created account gets a random
// temporary password, printed once here, and must change it at first login
// (same flow as User Management). The first Admin is NOT created here —
// use `npm run create-admin`.
//
// Idempotent — safe to re-run; on conflict it just reports the existing
// row instead of erroring or creating a duplicate.
//
// Run with: npx tsx --env-file=.env.local scripts/seed-auth-users.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import { users, leaders } from '../app/lib/db/schema';
import { generateTempPassword, hashPassword } from '../app/lib/auth/password';

async function upsertUser(params: { username: string; name: string; role: string; leaderId: number | null }) {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.username, params.username)).limit(1);
  if (existing) {
    console.log(`- ${params.username}: already exists (id=${existing.id}, role=${existing.role}), left unchanged`);
    return existing;
  }
  const tempPassword = generateTempPassword();
  const [created] = await db
    .insert(users)
    .values({ ...params, passwordHash: await hashPassword(tempPassword), mustChangePassword: true })
    .returning();
  console.log(`- ${params.username}: created (id=${created.id}, role=${created.role}) — temporary password: ${tempPassword}`);
  return created;
}

async function main() {
  const db = getDb();

  // Picks the first leader row (by id) — an arbitrary but real choice, so
  // the leader-role test account's "shop pool" isn't empty the first time
  // someone tries Shop replacement.
  const [testLeader] = await db.select().from(leaders).orderBy(leaders.id).limit(1);
  if (!testLeader) {
    throw new Error('No rows in leaders — cannot create a leader-role test account without a real leader to link it to.');
  }
  await upsertUser({ username: 'leader.test', name: `Leader Test (${testLeader.name})`, role: 'leader', leaderId: testLeader.id });
  await upsertUser({ username: 'ops.test', name: 'OPS Test', role: 'ops', leaderId: null });

  console.log(`\nLeader test account is linked to leaders.id=${testLeader.id} ("${testLeader.name}").`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
