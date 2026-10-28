// One-off, idempotent apply of the user-accounts migrations —
// drizzle-kit migrate has a known pre-existing gap in this project (see
// migration 0041's own apply script), so this runs each migration file's
// own statements directly, in order:
//   0044_add_auth_security.sql — users lockout/forced-change columns,
//     session ip/user-agent, auth_audit_log
//   0045_add_roles.sql — roles + role_permissions, seeded with the
//     approved default access (seeding skips roles that already have
//     permissions, so re-running never undoes Roles-screen edits)
// Purely additive: no existing row is modified.
//
// Run with: npm run auth:migrate
import { readFileSync } from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';

const FILES = ['0044_add_auth_security.sql', '0045_add_roles.sql'];

async function main() {
  const db = getDb();
  for (const name of FILES) {
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
