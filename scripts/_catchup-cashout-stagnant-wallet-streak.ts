// One-off catch-up for stagnant_balance_wallet_streak (Cashout) — replays
// every Cashout Estimated Balance upload that landed while the table was
// still frozen to its 2026-10-16 file seed (the live +1 hook only went in
// 2026-10-20), using each upload's own stored per-wallet Withdrawal
// (estimated_balance_wallet_lines; estimated_balance_entries for an
// unsplit shop's '' key). Same +1/reset rule and same key set as
// importEstimatedOpeningFromUpload()'s own live hook.
//
// An existing row only replays uploads AFTER its own updated_at, so a row
// already cleared same-day (by either upload pipeline) counts up from that
// clear, never from before it. Active agents only, same as the live hook.
//
// Dry run by default; pass --apply to write.
// npx tsx --env-file=.env.local scripts/_catchup-cashout-stagnant-wallet-streak.ts [--apply]
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { extractOpeningWalletTypeSuffix } from '../app/lib/realShopName';

const SUFFIX_TO_WALLET_TYPE: Record<string, string> = { BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY' };
const SEED_AT = '2026-10-16 09:45:37.851+00';

async function main() {
  const apply = process.argv.includes('--apply');
  const db = getDb();
  const rows = <T>(x: unknown) => ((x as { rows?: T[] }).rows ?? (x as T[]));

  const uploads = rows<{ id: number; uploaded_at: string; cutoff_date: string }>(await db.execute(sql`
    SELECT id, uploaded_at, cutoff_date FROM estimated_balance_uploads
    WHERE product = 'cashout' AND uploaded_at > ${SEED_AT} ORDER BY uploaded_at
  `));
  if (uploads.length === 0) { console.log('No uploads to replay.'); process.exit(0); }
  const ids = sql.join(uploads.map((u) => sql`${u.id}`), sql`, `);
  const entryWd = new Map(rows<{ upload_id: number; agent_id: number; wd: number }>(await db.execute(sql`
    SELECT upload_id, agent_id, withdrawal::float8 AS wd FROM estimated_balance_entries WHERE upload_id IN (${ids})
  `)).map((e) => [`${e.upload_id}|${e.agent_id}`, e.wd]));
  const lineWd = new Map(rows<{ upload_id: number; agent_id: number; wallet_type: string; wd: number }>(await db.execute(sql`
    SELECT upload_id, agent_id, wallet_type, SUM(withdrawal::float8) AS wd FROM estimated_balance_wallet_lines
    WHERE upload_id IN (${ids}) GROUP BY 1, 2, 3
  `)).map((l) => [`${l.upload_id}|${l.agent_id}|${l.wallet_type}`, l.wd]));

  const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.product, 'cashout'), eq(schema.agents.isActive, true)));
  const agentIds = agents.map((a) => a.id);
  const [openingLines, existing] = await Promise.all([
    db.select({ agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName })
      .from(schema.openingWalletLines).where(inArray(schema.openingWalletLines.agentId, agentIds)),
    db.select().from(schema.stagnantBalanceWalletStreak).where(inArray(schema.stagnantBalanceWalletStreak.agentId, agentIds)),
  ]);

  const keys = new Set<string>();
  const withLines = new Set<number>();
  for (const l of openingLines) { withLines.add(l.agentId); keys.add(`${l.agentId}|${extractOpeningWalletTypeSuffix(l.rawAgentName) ?? ''}`); }
  for (const id of agentIds) if (!withLines.has(id)) keys.add(`${id}|`);
  const existingByKey = new Map(existing.map((r) => [`${r.agentId}|${r.walletSuffix}`, r]));
  for (const k of existingByKey.keys()) keys.add(k);

  const latestCutoff = uploads[uploads.length - 1].cutoff_date;
  const now = new Date();
  const out: (typeof schema.stagnantBalanceWalletStreak.$inferInsert)[] = [];
  let changed = 0, inserted = 0, flaggedBefore = 0, flaggedAfter = 0;
  for (const key of keys) {
    const sep = key.indexOf('|');
    const agentId = Number(key.slice(0, sep));
    const walletSuffix = key.slice(sep + 1);
    const ex = existingByKey.get(key);
    const since = ex?.updatedAt ? ex.updatedAt.getTime() : -Infinity;
    let days = ex?.noDataStreakDays ?? 0;
    // A key with no row yet (a shop not in the seed file — new, or
    // unmatched then) only counts from the first upload it actually
    // appears in, so a shop added mid-week isn't credited idle days from
    // before it existed. Never appeared → left for the live hook.
    const firstSeenIdx = ex ? 0 : uploads.findIndex((u) => entryWd.has(`${u.id}|${agentId}`));
    if (firstSeenIdx === -1) continue;
    for (const u of uploads.slice(firstSeenIdx)) {
      if (new Date(u.uploaded_at).getTime() <= since) continue;
      const wd = walletSuffix === ''
        ? (entryWd.get(`${u.id}|${agentId}`) ?? 0)
        : (lineWd.get(`${u.id}|${agentId}|${SUFFIX_TO_WALLET_TYPE[walletSuffix]}`) ?? 0);
      days = wd !== 0 ? 0 : days + 1;
    }
    if ((ex?.noDataStreakDays ?? 0) >= 3) flaggedBefore++;
    if (days >= 3) flaggedAfter++;
    if (!ex) inserted++; else if (ex.noDataStreakDays !== days) changed++;
    out.push({ agentId, walletSuffix, noDataStreakDays: days, fileAsOfDate: latestCutoff, updatedAt: now });
  }

  console.log({ replayed: uploads.map((u) => u.cutoff_date), keys: keys.size, changed, inserted, flaggedBefore, flaggedAfter, apply });
  if (!apply) process.exit(0);

  await db.transaction(async (tx) => {
    for (let i = 0; i < out.length; i += 500) {
      await tx.insert(schema.stagnantBalanceWalletStreak).values(out.slice(i, i + 500)).onConflictDoUpdate({
        target: [schema.stagnantBalanceWalletStreak.agentId, schema.stagnantBalanceWalletStreak.walletSuffix],
        set: { noDataStreakDays: sql`excluded.no_data_streak_days`, fileAsOfDate: sql`excluded.file_as_of_date`, updatedAt: sql`excluded.updated_at` },
      });
    }
  });
  console.log('Applied.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
