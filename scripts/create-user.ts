// Creates an account from the terminal — the only way to make the first
// Admin (nobody can log in to User Management yet) and the only way to make
// the scheduler's 'system' service account (deliberately not offered in
// the UI). Asks for the username and password interactively; nothing is
// hardcoded, read from env, or echoed.
//
//   npm run create-admin          -> role admin
//   npm run create-system-user    -> role system (scheduler only)
//
// Uses whatever DATABASE_URL .env.local points at — check it first.
import readline from 'readline';
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import { users } from '../app/lib/db/schema';
import { hashPassword } from '../app/lib/auth/password';
import { validatePasswordRules } from '../app/lib/auth/passwordRules';
import { USERNAME_PATTERN, USERNAME_RULE } from '../app/lib/auth/userAdmin';
import { logAudit } from '../app/lib/auth/audit';

const role = process.argv.includes('--role=system') ? 'system' : 'admin';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

// Reads a line without echoing it (raw TTY mode, one keypress at a time).
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('Run this in an interactive terminal (passwords are typed, never piped).'));
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').host;
    } catch {
      return '(unset)';
    }
  })();
  console.log(`Creating a ${role.toUpperCase()} account on database host: ${host}\n`);

  const username = (await ask('Username: ')).trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new Error(`Invalid username — ${USERNAME_RULE}`);
  const name = (await ask(`Display name [${role === 'system' ? 'Scheduler' : username}]: `)).trim() || (role === 'system' ? 'Scheduler' : username);

  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${username}`).limit(1);
  if (existing) throw new Error(`Username "${username}" already exists (id=${existing.id}). Nothing changed.`);

  const password = await askHidden('Password: ');
  const ruleError = validatePasswordRules(password);
  if (ruleError) throw new Error(ruleError);
  const confirm = await askHidden('Confirm password: ');
  if (confirm !== password) throw new Error('Passwords do not match. Nothing changed.');

  const [created] = await db
    .insert(users)
    .values({
      username,
      name,
      role,
      passwordHash: await hashPassword(password),
      // The person typing it here chose it themselves — no forced change.
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      status: 'active',
    })
    .returning({ id: users.id });

  await logAudit({
    event: 'user_created',
    targetUserId: created.id,
    meta: { ip: null, userAgent: 'scripts/create-user.ts' },
    details: { username, role, via: 'terminal' },
  });

  console.log(`\nCreated ${role} "${username}" (id=${created.id}).`);
  if (role === 'system') {
    console.log('Put SCHEDULER_USERNAME / SCHEDULER_PASSWORD in .env.local for scripts/local-scheduler.ts.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nError: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
