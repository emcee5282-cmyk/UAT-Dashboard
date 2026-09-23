import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { verifyPassword } from './password';

export type VerifiedUser = {
  id: number;
  username: string;
  name: string | null;
  role: string;
  leaderId: number | null;
};

// Real, DB-backed check — replaces the previous hardcoded admin/admin123
// comparison now that the users table (see schema.ts) is actually wired
// in. The admin account itself still works with the same credentials;
// it's just a real row now (see scripts/seed-auth-users.ts), not a string
// comparison.
export async function verifyCredentials(username: string, password: string): Promise<VerifiedUser | null> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user || user.status !== 'active') return null;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, username: user.username, name: user.name, role: user.role, leaderId: user.leaderId };
}
