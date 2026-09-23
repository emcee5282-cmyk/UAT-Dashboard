// Investigate scope: how many Opening agents currently have a
// placeholder-looking leader (e.g. "New-TempAutoPlot") where a sibling
// shop (same raw-text family, i.e. same text minus its trailing wallet
// suffix) already has a real leader — read-only, no writes.
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const PLACEHOLDER_LEADER_NAMES = ['NEW SHOP', 'NEW-TEMPAUTOPLOT'];

// Same regex as realShopName.ts's own WALLET_SUFFIX_STRIP, but used WITHOUT
// the brand-whitelist check that follows it there (detectOpeningPatternB/
// extractOpeningWalletTypeSuffix require the brand to be a KNOWN_BRAND_NAMES
// entry) — this is deliberately brand-agnostic: "N-B2PS2-ARCANE040-BK" and
// "N-B2PS2-ARCANE040-NG" share this family key even though "ARCANE" isn't a
// recognized brand, which is exactly the case that needs fixing.
const RAW_WALLET_SUFFIX = /^(.*?[0-9])-?(BK|NG|RK|UP)$/i;

function familyKey(agentCode: string): string {
  const trimmed = agentCode.trim().toUpperCase();
  const m = RAW_WALLET_SUFFIX.exec(trimmed);
  return m ? m[1] : trimmed;
}

async function main() {
  const db = getDb();

  for (const product of ['cashout', 'sendmoney'] as const) {
    console.log(`\n=== ${product} ===`);
    const agentRows = await db
      .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, leaderId: schema.agents.leaderId, isActive: schema.agents.isActive })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), eq(schema.agents.isActive, true)));

    const leaderRows = await db.select().from(schema.leaders);
    const leaderNameById = new Map(leaderRows.map((l) => [l.id, l.name]));
    const placeholderLeaderIds = new Set(
      leaderRows.filter((l) => PLACEHOLDER_LEADER_NAMES.includes(l.name.trim().toUpperCase())).map((l) => l.id)
    );
    console.log('Placeholder leader rows found:', leaderRows.filter((l) => placeholderLeaderIds.has(l.id)).map((l) => `${l.id}:${l.name}`));

    // Build family -> real leader name map (same rule as balanceLimitService.ts's
    // leaderNameByFamily, just keyed on raw-text family instead of brand family).
    const familyLeaderName = new Map<string, string>();
    for (const a of agentRows) {
      if (!a.leaderId || placeholderLeaderIds.has(a.leaderId)) continue;
      const fam = familyKey(a.agentCode);
      if (!familyLeaderName.has(fam)) familyLeaderName.set(fam, leaderNameById.get(a.leaderId) ?? '');
    }

    const affected = agentRows.filter((a) => a.leaderId && placeholderLeaderIds.has(a.leaderId));
    console.log(`Agents with a placeholder leader: ${affected.length}`);

    let resolvable = 0;
    const samples: string[] = [];
    for (const a of affected) {
      const fam = familyKey(a.agentCode);
      const real = familyLeaderName.get(fam);
      if (real) {
        resolvable++;
        if (samples.length < 20) samples.push(`  ${a.agentCode} (family="${fam}") -> ${real}`);
      }
    }
    console.log(`Resolvable via a same-family sibling's real leader: ${resolvable}`);
    console.log('Sample:');
    samples.forEach((s) => console.log(s));
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
