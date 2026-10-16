// Reconciliation for Cashout agents stuck on the "New Shop"/"New-TempAutoPlot"
// placeholder leaders (ids 247/23) purely because their brand wasn't yet in
// KNOWN_BRAND_NAMES (realShopName.ts) at the time they were created/matched
// — see that file's own 2026-10-16 header comment for the full incident
// (NICO + 16 other brands, 659 agents). This does NOT merge/delete any
// agent rows or touch balances — it only reassigns leader_id, inferred from
// the SAME brand "family" (letters before the trailing digits, after
// stripping the wallet suffix) a shop's OTHER agent rows already carry,
// and ONLY when every sibling in that family agrees on one real leader
// (ambiguous families are left untouched, never guessed).
//
// Scoped to product = 'cashout' only — Send Money's own agentCode is
// ALWAYS the full raw string by design (not a mis-normalization bug), so
// running this unscoped would needlessly scan/risk ~16,700 unrelated rows.
//
// Run with: npx tsx --env-file=.env.local scripts/_fix-newshop-family-leader.ts
// Add --apply to actually write; without it, this only reports what WOULD
// change (dry run).
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';

// Literal SQL, not a bound array param — Postgres' ANY()/ALL() need a real
// array on the right side, and drizzle's sql`` tag binds a JS array as a
// row-value tuple ($1,$2), not an array literal, which ANY/ALL both reject
// (confirmed live: "op ANY/ALL (array) requires array on right side").
// These two ids are fixed constants (New-TempAutoPlot, NEW SHOP), never
// user input, so inlining them as literal SQL is safe.
const PLACEHOLDER_LEADER_IDS_SQL = sql.raw('(23, 247)');

async function main() {
  const apply = process.argv.includes('--apply');
  const db = getDb();

  const { rows: before } = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM agents WHERE product = 'cashout' AND leader_id IN ${PLACEHOLDER_LEADER_IDS_SQL}
  `)) as unknown as { rows: { n: number }[] };
  console.log('Cashout agents currently on a placeholder leader:', before[0].n);

  const resolvable = (await db.execute(sql`
    WITH core AS (
      SELECT a.id, a.agent_code, a.leader_id AS lid,
             regexp_replace(a.agent_code, '-(BK|NG|RK|UP)$', '', 'i') AS c
      FROM agents a
      WHERE a.product = 'cashout'
    ),
    fam AS (
      SELECT id, agent_code, lid, (regexp_match(c, '([A-Za-z]+)[0-9]+$'))[1] AS family
      FROM core
    ),
    family_leader AS (
      SELECT family, MIN(lid) AS real_leader_id, COUNT(DISTINCT lid) AS distinct_leaders
      FROM fam
      WHERE family IS NOT NULL AND lid NOT IN ${PLACEHOLDER_LEADER_IDS_SQL}
      GROUP BY family
      HAVING COUNT(DISTINCT lid) = 1
    )
    SELECT fam.id AS agent_id, fam.agent_code, fam.family, family_leader.real_leader_id
    FROM fam
    JOIN family_leader ON family_leader.family = fam.family
    WHERE fam.lid IN ${PLACEHOLDER_LEADER_IDS_SQL}
  `)) as unknown as { rows: { agent_id: number; agent_code: string; family: string; real_leader_id: number }[] };

  const toFix = resolvable.rows;
  console.log('Resolvable via an unambiguous sibling family:', toFix.length);
  console.log('Sample:', toFix.slice(0, 10).map((r) => `${r.agent_code} (family ${r.family}) -> leader_id ${r.real_leader_id}`));

  const stillUnresolved = before[0].n - toFix.length;
  console.log('Will remain on a placeholder leader (no unambiguous family match found):', stillUnresolved);

  if (!apply) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const row of toFix) {
      await tx.execute(sql`UPDATE agents SET leader_id = ${row.real_leader_id}, updated_at = now() WHERE id = ${row.agent_id}`);
    }
  });

  const { rows: after } = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM agents WHERE product = 'cashout' AND leader_id IN ${PLACEHOLDER_LEADER_IDS_SQL}
  `)) as unknown as { rows: { n: number }[] };
  console.log('\nApplied. Cashout agents remaining on a placeholder leader:', after[0].n);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
