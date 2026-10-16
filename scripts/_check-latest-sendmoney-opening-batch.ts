// Read-only diagnostic: inspects the most recent Send Money 'opening'
// import batch's own counts (rowCount vs validCount/duplicateCount/
// errorCount) to see how many rows in the uploaded file were silently
// skipped (present but both Opening Balance and SDP were 0) vs genuinely
// matched/processed. Run with:
// npx tsx --env-file=.env.local scripts/_check-latest-sendmoney-opening-batch.ts
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

async function main() {
  const db = getDb();

  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.product, 'sendmoney'), eq(schema.importBatches.importType, 'opening')))
    .orderBy(desc(schema.importBatches.uploadedAt))
    .limit(5);

  console.log('Recent Send Money opening import batches:', JSON.stringify(batches, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
