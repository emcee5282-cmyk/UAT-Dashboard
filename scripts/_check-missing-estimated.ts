// One-off: check why a list of raw shop-wallet names are missing from
// Estimated Balance. Cross-references Opening's own roster/wallet-lines
// against estimated_balance_entries / estimated_balance_wallet_lines for
// the most recent cashout upload.
// Run with: npx tsx --env-file=.env.local scripts/_check-missing-estimated.ts
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { extractRealShopName, extractOpeningWalletTypeSuffix } from '../app/lib/realShopName';

const RAW_NAMES = `
N-B5AG-D2-KAIDO012-UP
N-B5AG-D2-KAIDO013-UP
N-M1AG-D1-DOGG011-NG
N-M1AG-D1-DOGG012-NG
N-M1AG-D2-SANJI010-BK
N-M1AG-D2-SANJI012-BK
N-M1AG-K4-CLAW002-BK
N-M1AG-K4-CLAW002-NG
N-M1AG-R6-NICO048-NG
N-M1AG-R6-NICO049-NG
N-M1AG-R6-NICO050-NG
N-M1AG-R6-NICO051-NG
N-M1AG-R6-NICO052-NG
N-M1AG-R6-NICO053-NG
N-M1AG-R6-NICO054-NG
N-M1AG-R6-NICO055-NG
N-M1AG-R6-NICO056-BK
N-M1AG-R6-NICO057-BK
N-M1AG-R6-NICO058-BK
`.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

async function main() {
  const db = getDb();

  // Latest cashout estimated-balance upload.
  const [lastUpload] = await db
    .select()
    .from(schema.estimatedBalanceUploads)
    .where(eq(schema.estimatedBalanceUploads.product, 'cashout'))
    .orderBy(desc(schema.estimatedBalanceUploads.uploadedAt))
    .limit(1);
  console.log('Last cashout estimated-balance upload:', lastUpload?.fileName, lastUpload?.uploadedAt, 'id=', lastUpload?.id, 'cutoffDate=', lastUpload?.cutoffDate);

  for (const raw of RAW_NAMES) {
    const bareCode = extractRealShopName(raw);
    const suffix = extractOpeningWalletTypeSuffix(raw);
    console.log('\n===', raw, '=> bareCode:', bareCode, 'suffix:', suffix);

    // 1. Is this bare code an active Opening agent (cashout)?
    const agentRows = await db
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive, openingBalance: schema.agents.openingBalance })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, 'cashout'), eq(schema.agents.agentCode, bareCode)));
    if (agentRows.length === 0) {
      console.log('  Opening agent: NOT FOUND for bareCode', bareCode);
      continue;
    }
    const agent = agentRows[0];
    console.log('  Opening agent:', agent.id, 'isActive:', agent.isActive, 'openingBalance:', agent.openingBalance);

    // 2. opening_wallet_lines for this agent — what does Opening itself have?
    const lines = await db
      .select()
      .from(schema.openingWalletLines)
      .where(eq(schema.openingWalletLines.agentId, agent.id));
    console.log('  opening_wallet_lines (', lines.length, '):');
    for (const l of lines) {
      console.log('    id=', l.id, 'raw=', JSON.stringify(l.rawAgentName), 'opening=', l.openingBalance, 'suffix=', extractOpeningWalletTypeSuffix(l.rawAgentName));
    }

    // 3. estimated_balance_entries / wallet lines for this agent (from latest upload).
    if (lastUpload) {
      const entryRows = await db
        .select()
        .from(schema.estimatedBalanceEntries)
        .where(and(eq(schema.estimatedBalanceEntries.uploadId, lastUpload.id), eq(schema.estimatedBalanceEntries.agentId, agent.id)));
      console.log('  estimated_balance_entries (this upload):', entryRows.length, entryRows.map((e) => ({ deposit: e.deposit, withdrawal: e.withdrawal, assumedBalance: e.assumedBalance })));

      const walletRows = await db
        .select()
        .from(schema.estimatedBalanceWalletLines)
        .where(and(eq(schema.estimatedBalanceWalletLines.uploadId, lastUpload.id), eq(schema.estimatedBalanceWalletLines.agentId, agent.id)));
      console.log('  estimated_balance_wallet_lines (this upload):', walletRows.length, walletRows.map((w) => ({ walletType: w.walletType, deposit: w.deposit, withdrawal: w.withdrawal })));
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
