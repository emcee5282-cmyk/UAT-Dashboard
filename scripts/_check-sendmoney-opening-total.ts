// Read-only diagnostic: compares the Send Money Opening page's own total
// (active agents only) against the full roster (including inactive), and
// checks for duplicate agent codes that could double-count a shop's
// opening balance. Run with:
// npx tsx --env-file=.env.local scripts/_check-sendmoney-opening-total.ts
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';

async function main() {
  const db = getDb();

  const [activeSum] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`coalesce(sum(${schema.agents.openingBalance}), 0)`,
      sdpTotal: sql<string>`coalesce(sum(${schema.agents.sdp}), 0)`,
    })
    .from(schema.agents)
    .where(and(eq(schema.agents.product, 'sendmoney'), eq(schema.agents.isActive, true)));

  const [inactiveSum] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`coalesce(sum(${schema.agents.openingBalance}), 0)`,
      sdpTotal: sql<string>`coalesce(sum(${schema.agents.sdp}), 0)`,
    })
    .from(schema.agents)
    .where(and(eq(schema.agents.product, 'sendmoney'), eq(schema.agents.isActive, false)));

  const [allSum] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`coalesce(sum(${schema.agents.openingBalance}), 0)`,
    })
    .from(schema.agents)
    .where(eq(schema.agents.product, 'sendmoney'));

  const dupes = await db.execute(sql`
    SELECT agent_code, count(*) as cnt, sum(opening_balance) as total
    FROM agents
    WHERE product = 'sendmoney' AND is_active = true
    GROUP BY agent_code
    HAVING count(*) > 1
    ORDER BY cnt DESC
    LIMIT 20
  `);

  console.log('Active agents:', activeSum);
  console.log('Inactive agents:', inactiveSum);
  console.log('All agents (active+inactive):', allSum);
  console.log('Duplicate agent_code rows (active):', dupes.rows);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
