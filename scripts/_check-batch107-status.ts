import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const [b] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, 107));
  console.log(b);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
