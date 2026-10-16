// Read-only diagnostic: inspects two specific Send Money agents the user
// flagged as showing a wrong (non-zero) opening balance when it should be
// 0. Run with:
// npx tsx --env-file=.env.local scripts/_check-specific-sendmoney-agents.ts
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

const CODES = ['N-B2BD-DELTA079-RK', 'N-B2BD-DELTA080-RK'];

async function main() {
  const db = getDb();

  const agents = await db
    .select({
      id: schema.agents.id,
      agentCode: schema.agents.agentCode,
      product: schema.agents.product,
      leaderId: schema.agents.leaderId,
      openingBalance: schema.agents.openingBalance,
      previousOpeningBalance: schema.agents.previousOpeningBalance,
      sdp: schema.agents.sdp,
      isActive: schema.agents.isActive,
      lastImportMatchedAt: schema.agents.lastImportMatchedAt,
      updatedAt: schema.agents.updatedAt,
    })
    .from(schema.agents)
    .where(inArray(schema.agents.agentCode, CODES));

  console.log('Agents found:', JSON.stringify(agents, null, 2));

  if (agents.length > 0) {
    const ids = agents.map((a) => a.id);
    const walletLines = await db
      .select()
      .from(schema.openingWalletLines)
      .where(inArray(schema.openingWalletLines.agentId, ids));
    console.log('Opening wallet lines:', JSON.stringify(walletLines, null, 2));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
