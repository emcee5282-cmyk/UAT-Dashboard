// One-time (re-run on demand) seed from the reference "Stagnant
// balance.xlsx" report (the one the user already maintains manually), so
// the page shows real history instead of starting every shop at a 0-day
// streak. Rows with no matching agents row are skipped entirely — only
// real roster shops with a live Company Balance are ever tracked here.
//
// Cashout and Send Money are seeded very differently as of 2026-10-16:
//   - Send Money writes stagnant_balance_tracking (one row per shop) same
//     as always — its real upload data is already shop-level 1:1, no
//     wallet split exists, so the live per-upload hook stays authoritative
//     and this is just its one-time baseline.
//   - Cashout writes stagnant_balance_wallet_streak (one row per WALLET,
//     agentId + walletSuffix) instead, and is NEVER touched by the live
//     hook — per explicit instruction. Reason: Cashout's real uploaded WD
//     data is only ever tracked ONE combined figure per bare shop code, so
//     a shop with one still-active wallet and one genuinely idle wallet
//     got its live streak reset low for BOTH, masking the idle one. This
//     file tracks WD per wallet suffix, so for Cashout it's now the SOLE
//     source of the displayed streak, deliberately frozen between seed
//     runs rather than blended with the coarser live figure.
//
// WD HISTORY only — per explicit instruction, Deposit plays NO part in this
// at all, not even combined with WD. Both the Cashout and Send Money sheets
// carry a per-shop "WD HISTORY" text column ("last data N day(s)" /
// "No data"); that column's own day count IS the streak, verbatim — no
// min()/combination with DP HISTORY. "No data" means no Withdrawal at all
// THIS MONTH (per explicit clarification) — so it's treated as exactly how
// many days have elapsed in the current Manila business month so far
// (day-of-month of getBusinessToday()), not a fixed guess — a file read on
// the 15th treats "No data" as 15 days, read on the 28th it'd be 28.
//
// Columns are located BY HEADER NAME (row 2), not by fixed position — this
// same file has reshuffled its own column layout 3 times already in one
// day (sheet names Sheet1/Sheet2 -> Cashout/Sendmoney; Send Money gaining
// DP/WD HISTORY columns it didn't originally have; then the whole sheet
// getting columns removed/reordered down to SHOP|CLOSING BALANCE|SDP|
// NAME|DP HISTORY|WD HISTORY). A hardcoded column index silently breaks
// (reads the wrong column, or an out-of-range empty cell that defaults to
// the "No data" sentinel) every time this happens — header lookup doesn't.
// Sheet lookup itself is still by POSITION (first sheet = Cashout, second
// = Send Money) since the sheet NAMES have also changed and aren't a
// stable anchor either.
//
// Run with: npx tsx --env-file=.env.local scripts/_seed-stagnant-balance-from-file.ts "<path to .xlsx>"
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { getAgentIdsByCode } from '../app/lib/services/stagnantBalanceService';
import { normalizeOpeningAgentName, extractOpeningWalletTypeSuffix } from '../app/lib/realShopName';
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

// Scans the header row for a column whose own text matches one of the
// given candidate names (case-insensitive, whitespace-trimmed on both
// sides — the file's own headers carry stray leading/trailing spaces,
// e.g. " GROUP "). Throws loudly rather than silently defaulting to a
// wrong column if the file's own header wording changes again. Optional
// candidates (e.g. a leader column that might not exist on every sheet
// shape) return -1 instead of throwing when `required` is false.
function findColumnIndex(headerRow: ExcelJS.Row, columnCount: number, candidates: string[], required = true): number {
  const normalizedCandidates = candidates.map((c) => c.toUpperCase());
  for (let c = 1; c <= columnCount; c++) {
    const header = String(headerRow.getCell(c).value ?? '').trim().toUpperCase();
    if (normalizedCandidates.includes(header)) return c;
  }
  if (!required) return -1;
  throw new Error(`Could not find a column matching any of [${candidates.join(', ')}] — the file's header layout may have changed again.`);
}

type SeedRow = { agentCode: string; streakDays: number };

// Both sheets can carry more than one raw row for the SAME shop (a shop
// split across multiple wallets, e.g. "-BK" and "-NG" both extracting to
// the same bare Cashout code) — those must collapse to ONE row per
// agentCode before the upsert, since a single INSERT's own VALUES list
// can't target the same conflict key twice. Shop-level streak = the MIN
// across its wallets: if even one wallet had a Withdrawal recently, the
// whole shop's "no WD" streak was broken that recently too. Send Money
// only (Cashout now keeps its own per-wallet rows — see
// dedupeWalletRowsMin below).
function dedupeByAgentCodeMin(rows: SeedRow[]): SeedRow[] {
  const byCode = new Map<string, SeedRow>();
  for (const r of rows) {
    const existing = byCode.get(r.agentCode);
    if (!existing) {
      byCode.set(r.agentCode, r);
    } else {
      byCode.set(r.agentCode, { agentCode: r.agentCode, streakDays: Math.min(existing.streakDays, r.streakDays) });
    }
  }
  return Array.from(byCode.values());
}

// This file's own SHOP column mixes THREE different raw shapes row-to-row:
//   1. Already bare, e.g. "AEGIS021" / "CLOVE001"
//   2. Suffix glued on with no hyphen, e.g. "DIOR001BK" (= DIOR001 + BK)
//   3. Fully raw/prefixed, e.g. "N-M1AG-S9-ABYSSAL001-BK"
// extractRealShopName() only correctly handles shape 3 — it returns '' for
// shapes 1 and 2 (confirmed live: extractRealShopName('AEGIS021') === '',
// extractRealShopName('DIOR001BK') === '' too, since its own suffix-match
// regex requires a leading hyphen). Silently skipping every such row (the
// old `if (!agentCode) continue`) dropped hundreds of real Cashout shops
// from this run, caught live via a user-provided list that SHOULD have
// matched and didn't. normalizeOpeningAgentName() (Opening's own agent-
// name normalizer, used here instead) already handles all three shapes
// correctly — its own wallet-suffix-strip regex makes the hyphen OPTIONAL,
// and passes an already-bare code through unchanged when no suffix matches
// at all — so it's the right tool for this column, not extractRealShopName.
function resolveCashoutShopCode(raw: string | number | null): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return normalizeOpeningAgentName(trimmed);
}

type CashoutWalletSeedRow = { agentCode: string; walletSuffix: string; streakDays: number };

// Unlike Send Money, Cashout keeps EACH wallet's own row — no MIN-across-
// wallets collapse — since stagnant_balance_wallet_streak is keyed per
// wallet. Still dedupes exact (agentCode, walletSuffix) duplicates (the
// same wallet appearing twice in the file) via MIN, since a single INSERT's
// VALUES list can't target the same conflict key twice either.
// extractOpeningWalletTypeSuffix() returns null for an already-bare SHOP
// value (shape 1 above, no wallet info at all) — '' is used as that case's
// own wallet key, same bare-shop fallback stagnant_balance_wallet_streak's
// own schema comment describes.
function dedupeWalletRowsMin(rows: CashoutWalletSeedRow[]): CashoutWalletSeedRow[] {
  const byKey = new Map<string, CashoutWalletSeedRow>();
  for (const r of rows) {
    const key = `${r.agentCode}|${r.walletSuffix}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...r, streakDays: Math.min(existing.streakDays, r.streakDays) } : r);
  }
  return Array.from(byKey.values());
}

function readCashoutRows(ws: ExcelJS.Worksheet): CashoutWalletSeedRow[] {
  const headerRow = ws.getRow(2);
  const shopCol = findColumnIndex(headerRow, ws.columnCount, ['SHOP']);
  const wdCol = findColumnIndex(headerRow, ws.columnCount, ['WD HISTORY']);

  const rows: CashoutWalletSeedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = row.getCell(shopCol).value as string | number | null;
    const agentCode = resolveCashoutShopCode(raw);
    if (!agentCode) continue;
    const walletSuffix = extractOpeningWalletTypeSuffix(raw) ?? '';
    const wdDays = parseHistoryDays(row.getCell(wdCol).value);
    rows.push({ agentCode, walletSuffix, streakDays: wdDays });
  }
  return dedupeWalletRowsMin(rows);
}

// Send Money's own agentCode is the FULL raw code (e.g.
// "N-B2PS2-ZETSU004-NG", confirmed against a live DB sample) — unlike
// Cashout's stripped bare form, so the shop-identifier column is used
// as-is here, no extractRealShopName() needed.
function readSendMoneyRows(ws: ExcelJS.Worksheet): SeedRow[] {
  const headerRow = ws.getRow(2);
  const shopCol = findColumnIndex(headerRow, ws.columnCount, ['SHOP CODE', 'SHOP']);
  const wdCol = findColumnIndex(headerRow, ws.columnCount, ['WD HISTORY']);

  const rows: SeedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const agentCode = String(row.getCell(shopCol).value ?? '').trim();
    if (!agentCode) continue;
    const wdDays = parseHistoryDays(row.getCell(wdCol).value);
    rows.push({ agentCode, streakDays: wdDays });
  }
  return dedupeByAgentCodeMin(rows);
}

async function seedCashoutWalletStreak(rows: CashoutWalletSeedRow[], cutoffDateStr: string, now: Date) {
  const db = getDb();
  const agentIdByCode = await getAgentIdsByCode('cashout', rows.map((r) => r.agentCode));

  const matchedValues = rows
    .map((r) => {
      const agentId = agentIdByCode.get(r.agentCode);
      if (!agentId) return null;
      return { agentId, walletSuffix: r.walletSuffix, noDataStreakDays: r.streakDays, fileAsOfDate: cutoffDateStr, updatedAt: now };
    })
    .filter((v): v is { agentId: number; walletSuffix: string; noDataStreakDays: number; fileAsOfDate: string; updatedAt: Date } => v !== null);

  const CHUNK_SIZE = 500;
  for (let i = 0; i < matchedValues.length; i += CHUNK_SIZE) {
    await db
      .insert(schema.stagnantBalanceWalletStreak)
      .values(matchedValues.slice(i, i + CHUNK_SIZE))
      .onConflictDoUpdate({
        target: [schema.stagnantBalanceWalletStreak.agentId, schema.stagnantBalanceWalletStreak.walletSuffix],
        set: {
          noDataStreakDays: sql`excluded.no_data_streak_days`,
          fileAsOfDate: sql`excluded.file_as_of_date`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  const unmatchedCount = rows.length - matchedValues.length;
  console.log(`cashout: ${rows.length} file wallet rows -> ${matchedValues.length} matched to an agent, ${unmatchedCount} skipped (no agent record).`);
}

async function seedProduct(product: 'cashout' | 'sendmoney', rows: SeedRow[], cutoffDateStr: string, now: Date) {
  const db = getDb();
  const agentIdByCode = await getAgentIdsByCode(product, rows.map((r) => r.agentCode));

  const matchedValues = rows
    .map((r) => {
      const agentId = agentIdByCode.get(r.agentCode);
      if (!agentId) return null;
      return { agentId, noDataStreakDays: r.streakDays, lastCheckedCutoffDate: cutoffDateStr, updatedAt: now };
    })
    .filter((v): v is { agentId: number; noDataStreakDays: number; lastCheckedCutoffDate: string; updatedAt: Date } => v !== null);

  const CHUNK_SIZE = 500;
  for (let i = 0; i < matchedValues.length; i += CHUNK_SIZE) {
    await db
      .insert(schema.stagnantBalanceTracking)
      .values(matchedValues.slice(i, i + CHUNK_SIZE))
      .onConflictDoUpdate({
        target: schema.stagnantBalanceTracking.agentId,
        set: {
          noDataStreakDays: sql`excluded.no_data_streak_days`,
          lastCheckedCutoffDate: sql`excluded.last_checked_cutoff_date`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  const unmatchedCount = rows.length - matchedValues.length;
  console.log(`${product}: ${rows.length} file rows -> ${matchedValues.length} matched to an agent, ${unmatchedCount} skipped (no agent record).`);
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

  await seedCashoutWalletStreak(cashoutRows, cutoffDateStr, now);
  await seedProduct('sendmoney', sendMoneyRows, cutoffDateStr, now);

  console.log('Seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
