// One-off backfill: correct any ACTIVE agent whose Leader is currently a
// placeholder ("New-TempAutoPlot" / "NEW SHOP") but has a same-family
// sibling shop (same raw text minus its trailing wallet suffix — brand-
// agnostic, via extractRawWalletFamily) whose OWN Leader is already real —
// per explicit instruction, e.g. "N-B2PS2-ARCANE040-BK" (Leader:
// New-TempAutoPlot) should inherit "N-B2PS2-ARCANE040-NG"'s real Leader
// ("JEWEL"), since these are wallet lines of the same real shop that never
// got linked as one `agents` row (their brand, "ARCANE", isn't in
// KNOWN_BRAND_NAMES — see realShopName.ts's own extractRawWalletFamily
// comment). This is the retroactive half of the fix; importService.ts's
// importOpeningFile now also applies this going forward for newly-inserted
// shops, so this should be a true one-time catch-up.
//
// Read-only dry run by default — pass --apply to actually write.
// Run with:  npx tsx --env-file=.env.local scripts/backfill-family-leader.ts
//            npx tsx --env-file=.env.local scripts/backfill-family-leader.ts --apply
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { extractRawWalletFamily, extractShopSeriesFamily } from '../app/lib/realShopName';
import { buildFamilyLeaderMap, buildSeriesFamilyLeaderMap, isPlaceholderLeaderName } from '../app/lib/services/importService';

const APPLY = process.argv.includes('--apply');
const CHUNK_SIZE = 500;

async function main() {
  const db = getDb();
  let totalFixed = 0;

  for (const product of ['cashout', 'sendmoney'] as const) {
    console.log(`\n=== ${product} ===`);
    const familyLeaderMap = await buildFamilyLeaderMap(db, product);
    const seriesFamilyLeaderMap = await buildSeriesFamilyLeaderMap(db, product);

    const leaderRows = await db.select().from(schema.leaders);
    const leaderIdByName = new Map(leaderRows.map((l) => [l.name.trim().toUpperCase(), l.id]));

    const agentRows = await db
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, leaderId: schema.agents.leaderId })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));
    const leaderNameById = new Map(leaderRows.map((l) => [l.id, l.name]));

    const updates: { id: number; leaderId: number }[] = [];
    const preview: string[] = [];
    for (const a of agentRows) {
      const currentLeaderName = a.leaderId ? leaderNameById.get(a.leaderId) ?? '' : '';
      if (!isPlaceholderLeaderName(currentLeaderName)) continue;
      const fam = extractRawWalletFamily(a.agentCode);
      const series = extractShopSeriesFamily(a.agentCode);
      const realLeaderName = familyLeaderMap.get(fam) ?? (series ? seriesFamilyLeaderMap.get(series) : undefined);
      if (!realLeaderName) continue;
      const realLeaderId = leaderIdByName.get(realLeaderName.trim().toUpperCase());
      if (!realLeaderId) continue; // shouldn't happen (map was built from real leader rows), defensive only
      const matchedVia = familyLeaderMap.get(fam) ? `family="${fam}"` : `series="${series}"`;
      updates.push({ id: a.id, leaderId: realLeaderId });
      if (preview.length < 15) preview.push(`  ${a.agentCode} (${matchedVia}): "${currentLeaderName}" -> "${realLeaderName}"`);
    }

    console.log(`Agents to fix: ${updates.length}`);
    preview.forEach((p) => console.log(p));
    if (updates.length > 15) console.log(`  ... and ${updates.length - 15} more`);

    if (APPLY && updates.length > 0) {
      await db.transaction(async (tx) => {
        for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
          const chunk = updates.slice(i, i + CHUNK_SIZE);
          const values = sql.join(chunk.map((u) => sql`(${u.id}::int, ${u.leaderId}::int)`), sql`, `);
          await tx.execute(sql`
            UPDATE agents AS a
            SET leader_id = v.leader_id, updated_at = now()
            FROM (VALUES ${values}) AS v(id, leader_id)
            WHERE a.id = v.id
          `);
        }
      });
      console.log(`Applied: updated ${updates.length} agents.`);
    }
    totalFixed += updates.length;
  }

  console.log(`\n${APPLY ? 'Applied' : 'Would fix'} ${totalFixed} agents total across both products.`);
  if (!APPLY) console.log('Dry run only — re-run with --apply to write.');

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
