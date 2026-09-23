// One-time correction: estimated_balance_wallet_totals.wallet_type for
// Send Money uploads was stored as "BKASHC"/"NAGADC"/"ROCKETC"/"UPAYC"
// (the raw "Bank" column value, un-stripped) instead of the canonical
// "BKASH"/"NAGAD"/"ROCKET"/"UPAY" — see aggregateByWalletType's own fix in
// estimatedOpening.ts. Corrects all EXISTING rows (not just the latest
// upload) so nothing downstream ever sees the wrong key again.
import { eq, like } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const badRows = await db.select().from(schema.estimatedBalanceWalletTotals).where(like(schema.estimatedBalanceWalletTotals.walletType, '%C'));
  console.log('Rows with a trailing C:', badRows.length);
  for (const r of badRows) console.log(' ', r.id, r.uploadId, r.walletType);

  for (const r of badRows) {
    const fixed = r.walletType.replace(/C$/, '');
    await db.update(schema.estimatedBalanceWalletTotals).set({ walletType: fixed }).where(eq(schema.estimatedBalanceWalletTotals.id, r.id));
    console.log(`  fixed id=${r.id}: ${r.walletType} -> ${fixed}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
