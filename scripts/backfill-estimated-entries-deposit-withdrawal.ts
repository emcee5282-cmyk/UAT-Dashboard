// One-off backfill: estimated_balance_entries.deposit/withdrawal and
// estimated_balance_wallet_lines.deposit/withdrawal for EXISTING upload rows
// written before the DP/WD double-count fix (estimatedOpeningService.ts used
// to store deposit = fileDP + tx.topUp / withdrawal = fileWD + tx.settlement
// unconditionally — double-counting against the Estimated tabs' own
// dedicated Topup/Settlement-by-type columns, which independently sum the
// SAME wallet_transactions rows).
//
// Recomputes tx.topUp/tx.settlement per agent (and per agent+wallet for
// wallet-line rows) from wallet_transactions at activityDate =
// subtractDays(upload.cutoffDate, 1) — the EXACT SAME query the live write
// path (estimatedOpeningService.ts) now uses — then subtracts that from the
// currently-stored (blended) deposit/withdrawal to recover the pure file
// value. assumedBalance is NOT touched — its formula already includes
// tx.topUp/tx.settlement and stays correct/unchanged; only deposit/
// withdrawal (the double-counted display columns) are corrected.
//
// Scope is deliberately explicit (--uploadId=<id>[,<id>...]), not "all
// uploads": this reversal is only guaranteed correct for an upload whose
// original write already used the CURRENT activityDate logic (cutoffDate-1).
// An older upload written before that separate fix may have blended in
// wallet_transactions from the WRONG date, and subtracting today's
// correct-date amounts would not cleanly undo that. Only the uploads
// actually read by the app (the latest valid one per product) need this.
//
// Defaults to DRY RUN. Pass --apply to write.
//
// Run with: npx tsx --env-file=.env.local scripts/backfill-estimated-entries-deposit-withdrawal.ts --uploadId=27,30 [--apply]

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
    console.error('Required: --uploadId=<id>[,<id>...]  (e.g. --uploadId=27,30)');
    process.exit(1);
  }
  const uploadIds = uploadIdArg.split(',').map((s) => parseInt(s.trim(), 10));

  const uploads = await db.select().from(schema.estimatedBalanceUploads).where(inArray(schema.estimatedBalanceUploads.id, uploadIds));

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${uploads.length} upload(s) matched.\n`);

  for (const upload of uploads) {
    const activityDate = subtractDays(upload.cutoffDate, 1);
    console.log(`Upload ${upload.id} — ${upload.product}, cutoffDate=${upload.cutoffDate}, activityDate=${activityDate}, file="${upload.fileName}"`);

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
        const walletBucket = txByAgentWallet.get(key) ?? { topUp: 0, settlement: 0 };
        if (t.transactionType === 'topup') walletBucket.topUp += n(t.amount); else walletBucket.settlement += n(t.amount);
        txByAgentWallet.set(key, walletBucket);
      }
    }

    // --- estimated_balance_entries (whole-shop) ---
    const entryRows = await db.select().from(schema.estimatedBalanceEntries).where(eq(schema.estimatedBalanceEntries.uploadId, upload.id));
    let entryChanged = 0;
    for (const row of entryRows) {
      const tx = txByAgentId.get(row.agentId) ?? { topUp: 0, settlement: 0 };
      const currentDeposit = n(row.deposit);
      const currentWithdrawal = n(row.withdrawal);
      const newDeposit = currentDeposit - tx.topUp;
      const newWithdrawal = currentWithdrawal - tx.settlement;
      if (Math.abs(newDeposit - currentDeposit) < 0.005 && Math.abs(newWithdrawal - currentWithdrawal) < 0.005) continue;
      entryChanged++;
      if (entryChanged <= 5) {
        console.log(`  [entries] agentId=${row.agentId}: deposit ${currentDeposit.toFixed(2)} -> ${newDeposit.toFixed(2)}, withdrawal ${currentWithdrawal.toFixed(2)} -> ${newWithdrawal.toFixed(2)}`);
      }
      if (APPLY) {
        await db.update(schema.estimatedBalanceEntries).set({ deposit: String(newDeposit), withdrawal: String(newWithdrawal) }).where(eq(schema.estimatedBalanceEntries.id, row.id));
      }
    }
    console.log(`  [entries] ${entryChanged}/${entryRows.length} row(s) changed${entryChanged > 5 ? ' (showing first 5)' : ''}`);

    // --- estimated_balance_wallet_lines (per-wallet split shops) ---
    const lineRows = await db.select().from(schema.estimatedBalanceWalletLines).where(eq(schema.estimatedBalanceWalletLines.uploadId, upload.id));
    let lineChanged = 0;
    for (const row of lineRows) {
      const tx = txByAgentWallet.get(`${row.agentId}:${row.walletType}`) ?? { topUp: 0, settlement: 0 };
      const currentDeposit = n(row.deposit);
      const currentWithdrawal = n(row.withdrawal);
      const newDeposit = currentDeposit - tx.topUp;
      const newWithdrawal = currentWithdrawal - tx.settlement;
      if (Math.abs(newDeposit - currentDeposit) < 0.005 && Math.abs(newWithdrawal - currentWithdrawal) < 0.005) continue;
      lineChanged++;
      if (lineChanged <= 5) {
        console.log(`  [lines] agentId=${row.agentId} wallet=${row.walletType}: deposit ${currentDeposit.toFixed(2)} -> ${newDeposit.toFixed(2)}, withdrawal ${currentWithdrawal.toFixed(2)} -> ${newWithdrawal.toFixed(2)}`);
      }
      if (APPLY) {
        await db.update(schema.estimatedBalanceWalletLines).set({ deposit: String(newDeposit), withdrawal: String(newWithdrawal) }).where(eq(schema.estimatedBalanceWalletLines.id, row.id));
      }
    }
    console.log(`  [lines] ${lineChanged}/${lineRows.length} row(s) changed${lineChanged > 5 ? ' (showing first 5)' : ''}`);
    console.log('');
  }

  console.log(APPLY ? 'Applied.' : 'Dry run only — pass --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
