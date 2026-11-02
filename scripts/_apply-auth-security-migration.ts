// One-off, idempotent apply of the user-accounts migrations —
// drizzle-kit migrate has a known pre-existing gap in this project (see
// migration 0041's own apply script), so this runs each migration file's
// own statements directly, in order:
//   0044_add_auth_security.sql — users lockout/forced-change columns,
//     session ip/user-agent, auth_audit_log
//   0045_add_roles.sql — roles + role_permissions, seeded with the
//     approved default access (seeding skips roles that already have
//     permissions, so re-running never undoes Roles-screen edits)
//   0046_add_user_avatar.sql — nullable users.avatar (profile photo)
// Purely additive: no existing row is modified.
//
// Run with: npm run auth:migrate
import { readFileSync } from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';

const FILES = ['0044_add_auth_security.sql', '0045_add_roles.sql', '0046_add_user_avatar.sql'];

// 0045 seeds the default roles with ON CONFLICT DO NOTHING — harmless the
// first time, but on a re-run it would re-create any default role an Admin
// has since deleted on the Roles screen. So once the roles table exists,
// 0045 is skipped. (0044/0046 are plain ADD COLUMN IF NOT EXISTS — safe.)
async function shouldSkip(db: ReturnType<typeof getDb>, name: string): Promise<boolean> {
  if (name !== '0045_add_roles.sql') return false;
  const result = await db.execute(sql`select to_regclass('public.roles') is not null as present`);
  const rows = (result as unknown as { rows?: { present: boolean }[] }).rows ?? (result as unknown as { present: boolean }[]);
  return !!rows[0]?.present;
}

async function main() {
  const db = getDb();
  for (const name of FILES) {
    if (await shouldSkip(db, name)) {
      console.log(`${name}: skipped (roles table already exists — never re-seed over Roles-screen edits).`);
      continue;
    }
    const statements = readFileSync(path.join(__dirname, '..', 'drizzle', name), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    console.log(`${name}: applied (idempotent, ${statements.length} statements).`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
