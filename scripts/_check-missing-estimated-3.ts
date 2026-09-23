// Follow-up: inspect the one hit found (CLAW002NG, agents.id=84469) — is it
// an Opening-sourced agent or a Balance-Limit-minted ghost (no
// opening_wallet_lines, has agent_wallets/wallet_transactions activity)?
// Run with: npx tsx --env-file=.env.local scripts/_check-missing-estimated-3.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

async function main() {
  const db = getDb();
  const agentId = 84469;

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  console.log('agent:', agent);

  const lines = await db.select().from(schema.openingWalletLines).where(eq(schema.openingWalletLines.agentId, agentId));
  console.log('opening_wallet_lines:', lines);

  const wallets = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.agentId, agentId));
  console.log('agent_wallets:', wallets);

  const txns = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.agentId, agentId));
  console.log('wallet_transactions count:', txns.length);
  console.log('wallet_transactions sample:', txns.slice(0, 5));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
