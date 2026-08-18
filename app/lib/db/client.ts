import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

// Not wired into any page or API route yet — this module only exists so the
// connection can be tested and later migrations can run against it. Google
// Sheets remains the live data source for every existing page until a
// separate, explicit migration step swaps them over.
//
// Lazy singleton (not created at module load) so importing this file never
// throws in a context where DATABASE_URL isn't set (e.g. a build step that
// doesn't touch the DB).
let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL in .env.local');
  }
  // See drizzle.config.ts for why rejectUnauthorized is false — DO Managed
  // Postgres's cert isn't in Node's default trust store; connection stays
  // TLS-encrypted regardless, this only relaxes chain verification.
  _pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return _pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
