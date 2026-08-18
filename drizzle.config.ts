import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit is a standalone CLI (not run through Next.js), so it needs its
// own .env.local load — Next.js's automatic env loading doesn't apply here.
// Plain `dotenv/config` defaults to `.env`, not `.env.local` — must be
// pointed at it explicitly or DATABASE_URL silently resolves to nothing.
config({ path: '.env.local' });

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in .env.local');
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
