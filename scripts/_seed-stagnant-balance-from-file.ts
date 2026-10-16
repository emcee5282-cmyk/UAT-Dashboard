// One-time (re-run on demand) seed of stagnant_balance_tracking from the
// reference "Stagnant balance.xlsx" report (the one the user already
// maintains manually), so the page shows real history instead of starting
// every shop at a 0-day streak.
//
// WD HISTORY only — per explicit instruction, Deposit plays NO part in this
// at all, not even combined with WD. Both the Cashout and Send Money sheets
// carry a per-shop "WD HISTORY" text column ("last data N day(s)" /
// "No data"); that column's own day count IS the streak, verbatim — no
// min()/combination with DP HISTORY (which is read from the file but
// otherwise ignored here). "No data" means no Withdrawal at all THIS MONTH
// (per explicit clarification) — so it's treated as exactly how many days
// have elapsed in the current Manila business month so far (day-of-month
// of getBusinessToday()), not a fixed guess — a file read on the 15th
// treats "No data" as 15 days, read on the 28th it'd be 28.
//
// Sheet lookup is by POSITION (first sheet = Cashout, second = Send Money),
// not by name — the workbook's own sheet names changed between versions of
// this same report ("Sheet1"/"Sheet2" -> "Cashout"/"Sendmoney"), so pinning
// to a name would silently break again on the next rename.
//
// Run with: npx tsx --env-file=.env.local scripts/_seed-stagnant-balance-from-file.ts "<path to .xlsx>"
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { getAgentIdsByCode } from '../app/lib/services/stagnantBalanceService';
import { extractRealShopName } from '../app/lib/realShopName';
import { toDateOnlyString } from '../app/lib/services/estimatedOpeningService';
import { getBusinessToday, manilaFields } from '../app/lib/businessDate';

// Day-of-month of today's Manila business date — "No data" means no
// transaction since the 1st of this month, so this is exactly that many
// elapsed days, computed fresh each run rather than hardcoded.
const NO_DATA_SENTINEL_DAYS = manilaFields(getBusinessToday()).day;

function parseHistoryDays(raw: unknown): number {
  const text = String(raw ?? '').trim();
  const m = /last data (\d+) day/i.exec(text);
  if (m) return parseInt(m[1], 10);
  return NO_DATA_SENTINEL_DAYS; // "No data" — no transaction since month start
}

type SeedRow = { agentCode: string; streakDays: number };

// Both sheets can carry more than one raw row for the SAME shop (a shop
// split across multiple wallets, e.g. "-BK" and "-NG" both extracting to
// the same bare Cashout code) — those must collapse to ONE row per
// agentCode before the upsert, since a single INSERT's own VALUES list
// can't target the same conflict key twice. Shop-level streak = the MIN
// across its wallets: if even one wallet had a Withdrawal recently, the
// whole shop's "no WD" streak was broken that recently too.
function dedupeByAgentCodeMin(rows: SeedRow[]): SeedRow[] {
  const byCode = new Map<string, number>();
  for (const r of rows) {
    const existing = byCode.get(r.agentCode);
    byCode.set(r.agentCode, existing === undefined ? r.streakDays : Math.min(existing, r.streakDays));
  }
  return Array.from(byCode, ([agentCode, streakDays]) => ({ agentCode, streakDays }));
}

function readCashoutRows(ws: ExcelJS.Worksheet): SeedRow[] {
  const rows: SeedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawShop = row.getCell(1).value;
    const agentCode = extractRealShopName(rawShop as string | number | null);
    if (!agentCode) continue;
    const wdDays = parseHistoryDays(row.getCell(9).value); // WD HISTORY — DP HISTORY (col 8) is ignored
    rows.push({ agentCode, streakDays: wdDays });
  }
  return dedupeByAgentCodeMin(rows);
}

// Send Money's own agentCode is the FULL raw code (e.g.
// "N-B2PS2-ZETSU004-NG", confirmed against a live DB sample) — unlike
// Cashout's stripped bare form, so "SHOP CODE" (col 1) is used as-is here,
// no extractRealShopName() needed.
function readSendMoneyRows(ws: ExcelJS.Worksheet): SeedRow[] {
  const rows: SeedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const agentCode = String(row.getCell(1).value ?? '').trim();
    if (!agentCode) continue;
    const wdDays = parseHistoryDays(row.getCell(13).value); // WD HISTORY — DP HISTORY (col 12) is ignored
    rows.push({ agentCode, streakDays: wdDays });
  }
  return dedupeByAgentCodeMin(rows);
}

async function seedProduct(product: 'cashout' | 'sendmoney', rows: SeedRow[], cutoffDateStr: string, now: Date) {
  const db = getDb();
  const agentIdByCode = await getAgentIdsByCode(product, rows.map((r) => r.agentCode));

  const values = rows
    .map((r) => {
      const agentId = agentIdByCode.get(r.agentCode);
      if (!agentId) return null;
      return { agentId, noDataStreakDays: r.streakDays, lastCheckedCutoffDate: cutoffDateStr, updatedAt: now };
    })
    .filter((v): v is { agentId: number; noDataStreakDays: number; lastCheckedCutoffDate: string; updatedAt: Date } => v !== null);

  const CHUNK_SIZE = 500;
  for (let i = 0; i < values.length; i += CHUNK_SIZE) {
    await db
      .insert(schema.stagnantBalanceTracking)
      .values(values.slice(i, i + CHUNK_SIZE))
      .onConflictDoUpdate({
        target: schema.stagnantBalanceTracking.agentId,
        set: {
          noDataStreakDays: sql`excluded.no_data_streak_days`,
          lastCheckedCutoffDate: sql`excluded.last_checked_cutoff_date`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  console.log(`${product}: ${rows.length} file rows, ${values.length} matched to an agent (${rows.length - values.length} unmatched/skipped).`);
}

async function main() {
  const filePath = process.argv[2] ?? 'C:/Users/ejboy/Downloads/Telegram Desktop/Stagnant balance.xlsx';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const [sheet1, sheet2] = wb.worksheets;
  if (!sheet1 || !sheet2) throw new Error('Expected at least 2 sheets in the workbook (Cashout first, Send Money second).');

  const now = new Date();
  const cutoffDateStr = toDateOnlyString(now);

  const cashoutRows = readCashoutRows(sheet1);
  const sendMoneyRows = readSendMoneyRows(sheet2);

  await seedProduct('cashout', cashoutRows, cutoffDateStr, now);
  await seedProduct('sendmoney', sendMoneyRows, cutoffDateStr, now);

  console.log('Seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
