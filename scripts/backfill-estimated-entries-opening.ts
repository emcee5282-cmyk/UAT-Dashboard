// One-off backfill: estimated_balance_entries.opening and
// estimated_balance_wallet_lines.opening for EXISTING upload rows written
// before those columns existed (NULL after migration 0034).
//
// Recovers the exact baseline each row was originally built against by
// inverting the write-time formula (estimatedOpeningService.ts):
//   assumedBalance = opening + deposit + tx.topUp - withdrawal - tx.settlement
//   => opening = assumedBalance - deposit - tx.topUp + withdrawal + tx.settlement
// tx.topUp/tx.settlement are recomputed from wallet_transactions at
// activityDate = subtractDays(upload.cutoffDate, 1) — the EXACT SAME query
// the write path uses — same approach already proven correct by
// scripts/backfill-estimated-entries-deposit-withdrawal.ts.
//
// Defaults to DRY RUN. Pass --apply to write.
// Run with: npx tsx --env-file=.env.local scripts/backfill-estimated-entries-opening.ts --uploadId=<id>[,<id>...] [--apply]

import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { subtractDays } from '../app/lib/services/estimatedWalletCascade';

const db = getDb();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const uploadIdArg = args.find((a) => a.startsWith('--uploadId='))?.split('=')[1];

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

async function main() {
  if (!uploadIdArg) {
    console.error('Required: --uploadId=<id>[,<id>...]  (e.g. --uploadId=32,31)');
    process.exit(1);
  }
  const uploadIds = uploadIdArg.split(',').map((s) => parseInt(s.trim(), 10));

  const uploads = await db.select().from(schema.estimatedBalanceUploads).where(inArray(schema.estimatedBalanceUploads.id, uploadIds));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${uploads.length} upload(s) matched.\n`);

  for (const upload of uploads) {
    const activityDate = subtractDays(upload.cutoffDate, 1);
    console.log(`Upload ${upload.id} — ${upload.product}, cutoffDate=${upload.cutoffDate}, activityDate=${activityDate}`);

    const txRows = await db
      .select({ agentId: schema.walletTransactions.agentId, transactionType: schema.walletTransactions.transactionType, amount: schema.walletTransactions.amount, wallet: schema.walletTransactions.wallet })
      .from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.product, upload.product), eq(schema.walletTransactions.occurredOn, activityDate)));

    const txByAgentId = new Map<number, { topUp: number; settlement: number }>();
    const txByAgentWallet = new Map<string, { topUp: number; settlement: number }>();
    for (const t of txRows) {
      const bucket = txByAgentId.get(t.agentId) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') bucket.topUp += n(t.amount); else bucket.settlement += n(t.amount);
      txByAgentId.set(t.agentId, bucket);
      if (t.wallet) {
        const key = `${t.agentId}:${t.wallet}`;
        const wb = txByAgentWallet.get(key) ?? { topUp: 0, settlement: 0 };
        if (t.transactionType === 'topup') wb.topUp += n(t.amount); else wb.settlement += n(t.amount);
        txByAgentWallet.set(key, wb);
      }
    }

    // --- estimated_balance_entries (whole-shop) ---
    const entryRows = await db.select().from(schema.estimatedBalanceEntries).where(eq(schema.estimatedBalanceEntries.uploadId, upload.id));
    let entryChanged = 0;
    for (const row of entryRows) {
      if (row.opening !== null) continue; // already backfilled / written post-fix
      const tx = txByAgentId.get(row.agentId) ?? { topUp: 0, settlement: 0 };
      const deposit = n(row.deposit);
      const withdrawal = n(row.withdrawal);
      const assumedBalance = n(row.assumedBalance);
      const opening = assumedBalance - deposit - tx.topUp + withdrawal + tx.settlement;
      entryChanged++;
      if (entryChanged <= 5) console.log(`  [entries] agentId=${row.agentId}: opening -> ${opening.toFixed(2)}`);
      if (APPLY) {
        await db.update(schema.estimatedBalanceEntries).set({ opening: String(opening) }).where(eq(schema.estimatedBalanceEntries.id, row.id));
      }
    }
    console.log(`  [entries] ${entryChanged}/${entryRows.length} row(s) backfilled${entryChanged > 5 ? ' (showing first 5)' : ''}`);

    // --- estimated_balance_wallet_lines (per-wallet split shops) ---
    const lineRows = await db.select().from(schema.estimatedBalanceWalletLines).where(eq(schema.estimatedBalanceWalletLines.uploadId, upload.id));
    let lineChanged = 0;
    for (const row of lineRows) {
      if (row.opening !== null) continue;
      const tx = txByAgentWallet.get(`${row.agentId}:${row.walletType}`) ?? { topUp: 0, settlement: 0 };
      const deposit = n(row.deposit);
      const withdrawal = n(row.withdrawal);
      const assumedBalance = n(row.assumedBalance);
      const opening = assumedBalance - deposit - tx.topUp + withdrawal + tx.settlement;
      lineChanged++;
      if (lineChanged <= 5) console.log(`  [lines] agentId=${row.agentId} wallet=${row.walletType}: opening -> ${opening.toFixed(2)}`);
      if (APPLY) {
        await db.update(schema.estimatedBalanceWalletLines).set({ opening: String(opening) }).where(eq(schema.estimatedBalanceWalletLines.id, row.id));
      }
    }
    console.log(`  [lines] ${lineChanged}/${lineRows.length} row(s) backfilled${lineChanged > 5 ? ' (showing first 5)' : ''}`);
    console.log('');
  }

  console.log(APPLY ? 'Applied.' : 'Dry run only — pass --apply to write.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
