// One-off backfill: estimated_balance_wallet_totals.settlement/topup for
// EXISTING upload rows (written before those columns existed, so they're
// NULL after the 0032 migration). Recomputes each upload's settlement/topup
// per wallet type from wallet_transactions using the EXACT SAME aggregation
// and normalization as the live upload path (estimatedOpeningService.ts's
// txByWalletType/normalizeWalletTypeOrUnmapped) — not re-derived here.
//
// Defaults to DRY RUN (prints what it would write, touches nothing).
// Pass --apply to actually write. Pass --cutoff=YYYY-MM-DD to limit scope to
// uploads with that exact cutoffDate (both products) — per explicit
// instruction, used first to review the 2026-09-26 numbers before a full run.
//
// Run with:  npx tsx --env-file=.env.local scripts/backfill-estimated-wallet-settlement-topup.ts [--cutoff=YYYY-MM-DD] [--apply]

import { eq, and } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const db = getDb();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const cutoffArg = args.find((a) => a.startsWith('--cutoff='))?.split('=')[1] ?? null;

function n(val: string | null): number {
  return val === null ? 0 : parseFloat(val);
}

const KNOWN_WALLET_TYPES = new Set(['BKASH', 'NAGAD', 'ROCKET', 'UPAY']);
function normalizeWalletTypeOrUnmapped(raw: string | null): string {
  const upper = (raw ?? '').trim().toUpperCase();
  return KNOWN_WALLET_TYPES.has(upper) ? upper : 'UNMAPPED';
}

async function main() {
  const uploads = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(cutoffArg ? eq(schema.estimatedBalanceUploads.cutoffDate, cutoffArg) : undefined);

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${uploads.length} upload(s) matched${cutoffArg ? ` (cutoff=${cutoffArg})` : ' (ALL uploads)'}.\n`);

  for (const upload of uploads) {
    const txRows = await db
      .select({ transactionType: schema.walletTransactions.transactionType, amount: schema.walletTransactions.amount, wallet: schema.walletTransactions.wallet })
      .from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.product, upload.product), eq(schema.walletTransactions.occurredOn, upload.cutoffDate)));

    const txByWalletType = new Map<string, { topUp: number; settlement: number }>();
    for (const t of txRows) {
      const walletType = normalizeWalletTypeOrUnmapped(t.wallet);
      const bucket = txByWalletType.get(walletType) ?? { topUp: 0, settlement: 0 };
      if (t.transactionType === 'topup') bucket.topUp += n(t.amount); else bucket.settlement += n(t.amount);
      txByWalletType.set(walletType, bucket);
    }

    const existingTotals = await db
      .select()
      .from(schema.estimatedBalanceWalletTotals)
      .where(eq(schema.estimatedBalanceWalletTotals.uploadId, upload.id));
    const existingByType = new Map(existingTotals.map((r) => [r.walletType, r]));

    console.log(`Upload ${upload.id} — ${upload.product}, cutoff=${upload.cutoffDate}, file="${upload.fileName}"`);
    // Always include all 4 known wallet types (never leave e.g. Rocket/UPay
    // out just because they had zero settlement/topup activity that date —
    // per explicit instruction, "no activity" must write 0.00, not be
    // skipped/left NULL), plus whatever else already exists (a stray type)
    // or has real tx activity (UNMAPPED).
    const allTypes = new Set([...KNOWN_WALLET_TYPES, ...existingByType.keys(), ...txByWalletType.keys()]);
    if (allTypes.size === 0) {
      console.log('  (no existing wallet-totals row and no wallet_transactions for this date — nothing to do)');
      continue;
    }

    for (const walletType of allTypes) {
      const existing = existingByType.get(walletType);
      const computed = txByWalletType.get(walletType) ?? { topUp: 0, settlement: 0 };
      const currentSettlement = existing ? existing.settlement : null;
      const currentTopup = existing ? existing.topup : null;
      const action = existing ? 'UPDATE' : 'INSERT';
      console.log(
        `  [${action}] ${walletType}: settlement ${currentSettlement ?? 'NULL'} -> ${computed.settlement.toFixed(2)}, topup ${currentTopup ?? 'NULL'} -> ${computed.topUp.toFixed(2)}`
      );

      if (APPLY) {
        if (existing) {
          await db
            .update(schema.estimatedBalanceWalletTotals)
            .set({ settlement: String(computed.settlement), topup: String(computed.topUp) })
            .where(eq(schema.estimatedBalanceWalletTotals.id, existing.id));
        } else {
          await db.insert(schema.estimatedBalanceWalletTotals).values({
            uploadId: upload.id,
            walletType,
            totalDp: '0',
            totalWd: '0',
            settlement: String(computed.settlement),
            topup: String(computed.topUp),
          });
        }
      }
    }
    console.log('');
  }

  console.log(APPLY ? 'Applied.' : 'Dry run only — pass --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
