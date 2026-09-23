// Investigate: does Balance tab's Opening-vs-Estimated fallback
// (balanceService.ts's computeTopUpSettlementCutoff/estimatedOpeningValid)
// still correctly pick Estimated Balance when today has no new Opening
// upload but Estimated Balance does have one?
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { getBusinessToday, toBusinessDate } from '../app/lib/businessDate';
import { readEstimatedOpeningPg } from '../app/lib/db/read/estimatedOpening';

async function main() {
  const db = getDb();
  const product = 'cashout' as const;
  const businessToday = getBusinessToday();
  console.log('businessToday:', businessToday);

  const [lastOpeningImport] = await db
    .select({ completedAt: schema.importBatches.completedAt, id: schema.importBatches.id })
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.product, product), eq(schema.importBatches.importType, 'opening'), eq(schema.importBatches.status, 'completed')))
    .orderBy(desc(schema.importBatches.completedAt))
    .limit(1);
  console.log('Last completed Opening import:', lastOpeningImport);

  const estimated = await readEstimatedOpeningPg(product);
  console.log('Latest Estimated Balance upload uploadedAt:', estimated.uploadedAt);
  console.log('estimated.balances.size:', estimated.balances.size);

  const lastKnownCutoff = lastOpeningImport?.completedAt ?? null;
  const estimatedOpeningValid =
    lastKnownCutoff !== null &&
    lastKnownCutoff.getTime() < businessToday.getTime() &&
    estimated.uploadedAt !== null &&
    toBusinessDate(estimated.uploadedAt).getTime() === businessToday.getTime();

  console.log('\nCondition breakdown:');
  console.log('  lastKnownCutoff !== null:', lastKnownCutoff !== null, lastKnownCutoff);
  console.log('  lastKnownCutoff < businessToday:', lastKnownCutoff ? lastKnownCutoff.getTime() < businessToday.getTime() : 'n/a');
  console.log('  estimated.uploadedAt !== null:', estimated.uploadedAt !== null, estimated.uploadedAt);
  console.log('  toBusinessDate(estimated.uploadedAt) === businessToday:', estimated.uploadedAt ? toBusinessDate(estimated.uploadedAt).getTime() === businessToday.getTime() : 'n/a', estimated.uploadedAt ? toBusinessDate(estimated.uploadedAt) : null);
  console.log('  => estimatedOpeningValid:', estimatedOpeningValid);

  // Spot check a real shop
  for (const code of ['AGATE003', 'AGATE001', 'WAND014', 'DRUID004']) {
    const [agent] = await db.select({ id: schema.agents.id, agentCode: schema.agents.agentCode, openingBalance: schema.agents.openingBalance, isActive: schema.agents.isActive })
      .from(schema.agents).where(and(eq(schema.agents.product, product), eq(schema.agents.agentCode, code)));
    if (!agent) { console.log(`\n${code}: not found`); continue; }
    const est = estimated.balances.get(agent.agentCode);
    console.log(`\n${code}: agentId=${agent.id} rawOpening=${agent.openingBalance} estimated.balances.get=${est} isActive=${agent.isActive}`);
    console.log(`  resolved opening (what Balance tab would show): ${estimatedOpeningValid ? (est ?? agent.openingBalance) : agent.openingBalance}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
