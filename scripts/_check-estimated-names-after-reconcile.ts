// Investigate user report: "Estimated shop names wrong again" after the
// batched-reconciliation fix landed and a real Opening upload ran. Checks
// the actual production reader (readEstimatedOpeningDisplayPg) for the
// shop families that were just reconciled (WAND, DRAGON025-027, DRUID,
// DAGGER003), looking for garbled/wrong display names or duplicates.
// Run with: npx tsx --env-file=.env.local scripts/_check-estimated-names-after-reconcile.ts
import { readEstimatedOpeningDisplayPg } from '../app/lib/db/read/estimatedOpening';

const WATCH_PREFIXES = ['WAND', 'DRAGON02', 'DRUID0', 'DAGGER003', 'DRAGON025', 'DRAGON026', 'DRAGON027'];

async function main() {
  const result = await readEstimatedOpeningDisplayPg('cashout');
  console.log('Total shopRows:', result.shopRows.length);
  console.log('Total walletRows:', result.walletRows.length);

  console.log('\n--- Matching shopRows ---');
  for (const r of result.shopRows) {
    if (WATCH_PREFIXES.some((p) => r.agentCode.toUpperCase().includes(p) || r.displayName.toUpperCase().includes(p))) {
      console.log(' ', JSON.stringify(r));
    }
  }

  console.log('\n--- Matching walletRows ---');
  for (const r of result.walletRows) {
    if (WATCH_PREFIXES.some((p) => r.agentCode.toUpperCase().includes(p) || r.shopDisplayName.toUpperCase().includes(p) || r.walletDisplayName.toUpperCase().includes(p))) {
      console.log(' ', JSON.stringify(r));
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
