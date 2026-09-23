// One-off backfill: bring a DATE RANGE into Postgres for the 3 sources the
// live app no longer auto-syncs from Sheets — TopUp + Settlement (both
// products) and CashGo (Cashout only). Extends scripts/_backfill-sept16.ts
// (same parsing shape, reused from scripts/migrate-data.ts's
// importWalletTransactions()) from a single day to an inclusive [START,END]
// range — idempotent, so re-running over an already-applied day (e.g. the
// 16th) is a safe no-op there (sourceRowRef dedup for wallet_transactions,
// onConflictDoUpdate for cashgo).
//
// Read-only dry run by default — pass --apply to actually write.
// Run with:  npx tsx --env-file=.env.local scripts/_backfill-range.ts
//            npx tsx --env-file=.env.local scripts/_backfill-range.ts --apply
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { fetchRange } from '../app/lib/googleSheets';
import { cleanText } from '../app/lib/db/sync/estimatedOpeningSync';
import { upsertCashgoEntry } from '../app/lib/services/dailyTxnEntryService';

const APPLY = process.argv.includes('--apply');
const START_DATE = '2026-09-21';
const END_DATE = '2026-09-23';
type Product = 'cashout' | 'sendmoney';

function inRange(date: string): boolean {
  return date >= START_DATE && date <= END_DATE;
}

function cleanNumber(val: unknown): number | null {
  const cleaned = cleanText(val).replace(/,/g, '');
  if (!cleaned || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

const BRAND_SUFFIX_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  if (parts.length >= 2 && BRAND_SUFFIX_CODES.includes(last)) return parts.slice(0, -1).join('-');
  return name;
}

function parseSlashDate(raw: string): string | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function backfillWalletTransactions(product: Product) {
  const db = getDb();
  const sheetName = product === 'cashout' ? 'AG BD STLM + TOPUP' : 'PS BD STLM + TOPUP';
  const rows = await fetchRange(sheetName);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  // Uppercased on both sides — the sheet's "To Agent" text is mixed-case for
  // some rows (e.g. "Jett037-M1") while agents.agent_code is stored upper
  // ("JETT037"); a case-sensitive Map lookup silently rejected those.
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode.toUpperCase(), a.id]));

  const existingRefs = new Set(
    (
      await db
        .select({ ref: schema.walletTransactions.sourceRowRef })
        .from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.product, product))
    ).map((r) => r.ref)
  );

  type NewTx = typeof schema.walletTransactions.$inferInsert;
  const toInsert: NewTx[] = [];
  const rejected: string[] = [];
  const byDate = new Map<string, { topup: number; settlement: number }>();

  function handleBlock(
    block: 'topup' | 'settlement',
    agentCol: number,
    amountCol: number,
    dateCol: number,
    walletCol: number,
    remarksCol: number | null
  ) {
    rows.slice(1).forEach((row, i) => {
      const sourceRowRef = `${product}:${block}:${i + 2}`;
      const rawDate = cleanText(row[dateCol]);
      const occurredOn = parseSlashDate(rawDate);
      if (!occurredOn || !inRange(occurredOn)) return; // date-scoped: everything else is out of scope for this backfill
      if (existingRefs.has(sourceRowRef)) return; // already imported

      const rawAgent = cleanText(row[agentCol]);
      const rawAmount = cleanText(row[amountCol]);
      if (!rawAgent || rawAgent === '-' || !rawAmount || rawAmount === '-') return;
      const agentCode = stripBrandSuffix(rawAgent);
      const agentId = agentIdByCode.get(agentCode.trim().toUpperCase());
      const amount = cleanNumber(rawAmount);
      if (!agentId) {
        rejected.push(`${block} row ${i + 2} (${occurredOn}): no matching agent for "${rawAgent}"`);
        return;
      }
      if (amount === null) {
        rejected.push(`${block} row ${i + 2} (${occurredOn}): unparseable amount "${rawAmount}"`);
        return;
      }
      toInsert.push({
        product,
        agentId,
        transactionType: block,
        amount: String(Math.abs(amount)),
        wallet: cleanText(row[walletCol]) || null,
        occurredOn,
        remarks: remarksCol !== null ? cleanText(row[remarksCol]) || null : null,
        sourceRowRef,
      });
      const d = byDate.get(occurredOn) ?? { topup: 0, settlement: 0 };
      d[block] += Math.abs(amount);
      byDate.set(occurredOn, d);
    });
  }

  handleBlock('topup', 1, 2, 3, 4, null);
  handleBlock('settlement', 7, 8, 9, 10, product === 'cashout' ? 11 : null);

  console.log(`\n=== ${product} wallet_transactions (${START_DATE}..${END_DATE}) ===`);
  console.log(`To insert: ${toInsert.length}`);
  Array.from(byDate.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).forEach(([date, sums]) =>
    console.log(`  ${date}: topup=${sums.topup.toFixed(2)} settlement=${sums.settlement.toFixed(2)}`)
  );
  if (rejected.length > 0) {
    console.log(`Rejected: ${rejected.length}`);
    rejected.slice(0, 15).forEach((r) => console.log(`  ${r}`));
    if (rejected.length > 15) console.log(`  ... and ${rejected.length - 15} more`);
  }

  if (APPLY && toInsert.length > 0) {
    await db.insert(schema.walletTransactions).values(toInsert);
    console.log(`Applied: inserted ${toInsert.length} rows.`);
  }
}

async function backfillCashgo() {
  const rows = await fetchRange('CashGo!A2:F');
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Walk every date in [START_DATE, END_DATE] and find its matching sheet
  // row by the "Month Day" label the CashGo tab uses (no year column).
  const [sy, sm, sd] = START_DATE.split('-').map(Number);
  const [ey, em, ed] = END_DATE.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);

  console.log(`\n=== cashgo (${START_DATE}..${END_DATE}) ===`);
  for (let t = start; t <= end; t += 86400000) {
    const dt = new Date(t);
    const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
    const row = rows.find((r) => cleanText(r[1]) === label);
    if (!row) {
      console.log(`  ${iso}: row not found, skipping`);
      continue;
    }
    const entries = [
      { channel: 'bkash' as const, target: cleanNumber(row[2]), process: cleanNumber(row[4]) },
      { channel: 'nagad' as const, target: cleanNumber(row[3]), process: cleanNumber(row[5]) },
    ].map((e) => ({ ...e, target: e.target === 0 ? null : e.target, process: e.process === 0 ? null : e.process }));

    console.log(`  ${iso}: bkash target=${entries[0].target} process=${entries[0].process} | nagad target=${entries[1].target} process=${entries[1].process}`);

    if (APPLY) {
      for (const e of entries) {
        await upsertCashgoEntry({ businessDate: iso, channel: e.channel, target: e.target, process: e.process });
      }
    }
  }
  if (APPLY) console.log('Applied: upserted cashgo rows.');
}

async function main() {
  await backfillWalletTransactions('cashout');
  await backfillWalletTransactions('sendmoney');
  await backfillCashgo();
  if (!APPLY) console.log('\nDry run only — re-run with --apply to write.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
