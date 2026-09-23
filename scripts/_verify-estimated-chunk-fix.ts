// Verify the chunked insert into estimated_balance_entries no longer hits
// Postgres's 65,535-bound-parameter limit at the scale that just failed
// (16,231 shops). Uses real agent ids (LIMIT 16231) so the FK constraint is
// satisfied, wrapped in a rolled-back transaction — nothing persists.
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const ROLLBACK_SENTINEL = new Error('__ROLLBACK__');
const INSERT_CHUNK_SIZE = 500;

async function main() {
  const db = getDb();
  const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.product, 'sendmoney')).limit(16231);
  console.log('Sample agent count for the test:', agents.length);

  try {
    await db.transaction(async (tx) => {
      const [upload] = await tx.insert(schema.estimatedBalanceUploads).values({
        product: 'sendmoney', uploadedBy: 'verify-script', uploadedAt: new Date(), cutoffDate: '2026-09-20', fileName: 'verify-test.xlsx', shopCount: agents.length,
      }).returning({ id: schema.estimatedBalanceUploads.id });

      const entryRows = agents.map((a) => ({ uploadId: upload.id, agentId: a.id, deposit: '0.00', withdrawal: '0.00', assumedBalance: '0.00' }));
      console.log(`Inserting ${entryRows.length} rows in chunks of ${INSERT_CHUNK_SIZE} (${entryRows.length * 5} total bound params across all chunks, max ${INSERT_CHUNK_SIZE * 5} per chunk)...`);
      for (let i = 0; i < entryRows.length; i += INSERT_CHUNK_SIZE) {
        await tx.insert(schema.estimatedBalanceEntries).values(entryRows.slice(i, i + INSERT_CHUNK_SIZE));
      }
      console.log('All chunks inserted successfully.');

      const count = await tx.select({ id: schema.estimatedBalanceEntries.id }).from(schema.estimatedBalanceEntries).where(eq(schema.estimatedBalanceEntries.uploadId, upload.id));
      console.log('Rows actually present mid-transaction:', count.length, '(expected', entryRows.length, ')');

      throw ROLLBACK_SENTINEL;
    });
  } catch (e) {
    if (e !== ROLLBACK_SENTINEL) throw e;
  }
  console.log('Rolled back — nothing persisted.');
  process.exit(0);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
