import { defineConfig } from 'drizzle-kit';

// drizzle-kit is a standalone CLI (not run through Next.js), so it needs its
// own .env.local load — Next.js's automatic env loading doesn't apply here.
// Loaded via Node's built-in --env-file flag (Node 20.6+, see the
// db:generate/db:migrate/db:studio scripts in package.json) rather than the
// dotenv package — this file no longer has any env-loading code of its own,
// it just expects DATABASE_URL to already be in process.env by the time it
// runs.
if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL — run via the db:generate/db:migrate/db:studio npm scripts (they pass --env-file=.env.local), not drizzle-kit directly.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL,
    // DigitalOcean Managed Postgres presents a cert not in Node's default
    // trust store; full chain verification fails without pinning DO's CA
    // bundle separately. The connection is still TLS-encrypted either way —
    // this only relaxes chain verification, a common pragmatic default for
    // managed providers. Upgrade path: pin DO's CA cert via `ssl.ca` if
    // stricter verification is ever required.
    ssl: { rejectUnauthorized: false },
  },
  verbose: true,
  strict: true,
});
