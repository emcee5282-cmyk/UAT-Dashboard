// Follow-up to _check-missing-estimated.ts: for the raw names whose
// extracted bare code wasn't found as an Opening agent, check (a) whether
// similar codes exist under a different exact string, and (b) whether the
// raw text itself shows up anywhere in opening_wallet_lines at all (i.e.
// Opening genuinely never received this shop), plus check which brand
// prefixes are unrecognized by extractRealShopName.
// Run with: npx tsx --env-file=.env.local scripts/_check-missing-estimated-2.ts
import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const CODES = ['KAIDO012', 'KAIDO013', 'DOGG011', 'DOGG012'];
const RAW_LIKE = ['%SANJI010%', '%SANJI012%', '%CLAW002%', '%NICO048%', '%NICO049%', '%NICO056%'];

async function main() {
  const db = getDb();

  for (const code of CODES) {
    const rows = await db
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive, product: schema.agents.product })
      .from(schema.agents)
      .where(ilike(schema.agents.agentCode, `%${code}%`));
    console.log(`agents LIKE %${code}%:`, rows);
  }

  console.log('\n--- opening_wallet_lines raw text search ---');
  for (const pat of RAW_LIKE) {
    const rows = await db
      .select({ id: schema.openingWalletLines.id, agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName })
      .from(schema.openingWalletLines)
      .where(ilike(schema.openingWalletLines.rawAgentName, pat));
    console.log(`opening_wallet_lines rawAgentName LIKE ${pat}:`, rows);
  }

  console.log('\n--- agent_wallets / wallet_transactions raw text search (do these shops exist anywhere as ghost agents?) ---');
  for (const pat of ['%SANJI010%', '%SANJI012%', '%CLAW002%', '%NICO048%', '%NICO056%', '%KAIDO012%', '%KAIDO013%', '%DOGG011%', '%DOGG012%']) {
    const rows = await db
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive, product: schema.agents.product })
      .from(schema.agents)
      .where(ilike(schema.agents.agentCode, pat));
    if (rows.length > 0) console.log(`agents LIKE ${pat}:`, rows);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
