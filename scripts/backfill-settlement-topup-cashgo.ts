// One-off backfill: Settlement + Top Up (Cashout & Send Money) and CashGo,
// last 60 days (2 months) excluding today, from Google Sheets into
// PostgreSQL — per explicit instruction. NOT wired into the regular
// scheduled sync (scripts/migrate-data.ts's runFastSync/runSlowSync stay
// untouched); run manually and only against whatever DATABASE_URL
// .env.local currently points at.
//
// Settlement/Top Up: wallet_transactions is fully wiped first ("remove all
// imported file also clean all from 0"), then reloaded fresh — column
// mapping/parsing copied from migrate-data.ts's own (currently disabled)
// importWalletTransactions(), minus its source_row_ref skip-if-exists check
// (table starts empty) and with an added last-60-days/exclude-today filter.
//
// CashGo: daily_txn_cashgo_entry (the table the Dashboard's CashGo widget
// actually reads — NOT the dead cashgo_daily table migrate-data.ts's own
// importCashgoDaily() writes to) is upserted with the Sheet as source of
// truth (onConflictDoUpdate, not onConflictDoNothing — this run
// deliberately overwrites, unlike the nightly rollover's own same-day
// manual-edit protection, which is untouched). Fixes two real parsing gaps
// in importCashgoDaily() that never mattered before only because that
// function targets the dead table: (1) quota cells like "10M"/"5M" need
// their M/K suffix multiplied out, not silently dropped by a plain
// parseFloat; (2) a Dec/Jan-spanning window needs the sheet's year-less
// "August 1" date rolled back a year if it would otherwise land in the
// future relative to today.
//
// Run with:  npx tsx scripts/backfill-settlement-topup-cashgo.ts

import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';
import { fetchRange } from '../app/lib/googleSheets';
import { cleanText } from '../app/lib/db/sync/estimatedOpeningSync';
import { getBusinessToday, manilaFields } from '../app/lib/businessDate';

type Product = 'cashout' | 'sendmoney';
const db = getDb();

const BACKFILL_WINDOW_DAYS = 60;

function toDateKey(date: Date): string {
  const { year, month, day } = manilaFields(date);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const TODAY_KEY = toDateKey(getBusinessToday());
const WINDOW_START_KEY = toDateKey(new Date(getBusinessToday().getTime() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000));

console.log(`Backfill window: ${WINDOW_START_KEY} (inclusive) .. ${TODAY_KEY} (exclusive, today itself is skipped)`);

// ---------------------------------------------------------------------------
// Shared parsing helpers — copied from scripts/migrate-data.ts's own
// (verified-correct) versions rather than re-deriving them.
// ---------------------------------------------------------------------------

function cleanNumber(val: unknown): number | null {
  const cleaned = cleanText(val).replace(/,/g, '');
  if (!cleaned || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// CashGo's own QUOTA cells carry an "M"/"K" shorthand suffix (e.g. "10M" =
// 10,000,000) that plain cleanNumber() silently drops (parseFloat("10M")
// stops at the digits). PROCESSED cells are already plain numbers — those
// keep using cleanNumber() as-is.
function parseQuotaAmount(val: unknown): number | null {
  const cleaned = cleanText(val).replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return 0;
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*([mk])?$/i);
  if (!match) return cleanNumber(val);
  const num = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return isNaN(num) ? null : num * multiplier;
}

const BRAND_SUFFIX_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  if (parts.length >= 2 && BRAND_SUFFIX_CODES.includes(last)) return parts.slice(0, -1).join('-');
  return name;
}

// "M/D/YYYY" (STLM+TOPUP) -> "YYYY-MM-DD"
function parseSlashDate(raw: string): string | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "June 1" (CashGo, no year) -> "YYYY-MM-DD", current Manila business year —
// then rolled back one year if that lands in the future (a Dec/Jan-spanning
// backfill window would otherwise misparse a real December date as next
// year's, which is always in the future relative to today).
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseCashGoDate(raw: string): string | null {
  const match = raw.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const monthIdx = MONTH_NAMES.indexOf(match[1]);
  if (monthIdx === -1) return null;
  const day = parseInt(match[2], 10);
  const { year } = manilaFields(getBusinessToday());
  const key = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (key <= TODAY_KEY) return key;
  return `${year - 1}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Part A — Settlement + Top Up: full wipe, then reload from Sheets, capped
// to the last 60 days and excluding today.
// ---------------------------------------------------------------------------

async function backfillWalletTransactions(product: Product): Promise<{ inserted: number; rejected: number; outOfWindow: number }> {
  const sheetName = product === 'cashout' ? 'AG BD STLM + TOPUP' : 'PS BD STLM + TOPUP';
  const rows = await fetchRange(sheetName);

  const agentRows = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));
  const agentIdByCode = new Map(agentRows.map((a) => [a.agentCode, a.id]));

  type NewTx = typeof schema.walletTransactions.$inferInsert;
  const toInsert: NewTx[] = [];
  let rejected = 0;
  let outOfWindow = 0;

  function handleBlock(
    block: 'topup' | 'settlement',
    agentCol: number,
    amountCol: number,
    dateCol: number,
    walletCol: number,
    remarksCol: number | null
  ) {
    rows.slice(1).forEach((row, i) => {
      const sourceRowRef = `${product}:${block}:${i + 2}`; // +2 = 1-based sheet row, header on row 1
      const rawAgent = cleanText(row[agentCol]);
      const rawAmount = cleanText(row[amountCol]);
      const rawDate = cleanText(row[dateCol]);
      if (!rawAgent || rawAgent === '-' || !rawAmount || rawAmount === '-') return; // blank row, not an error
      const agentCode = stripBrandSuffix(rawAgent);
      const agentId = agentIdByCode.get(agentCode);
      const occurredOn = parseSlashDate(rawDate);
      const amount = cleanNumber(rawAmount);
      if (!agentId || !occurredOn || amount === null) {
        rejected++;
        return;
      }
      if (occurredOn < WINDOW_START_KEY || occurredOn >= TODAY_KEY) {
        outOfWindow++;
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
    });
  }

  handleBlock('topup', 1, 2, 3, 4, null); // B-F: agent,amount,date,wallet,type(unused)
  handleBlock('settlement', 7, 8, 9, 10, product === 'cashout' ? 11 : null); // H-K(+L remarks, Cashout only)

  if (toInsert.length > 0) {
    await db.insert(schema.walletTransactions).values(toInsert);
  }
  return { inserted: toInsert.length, rejected, outOfWindow };
}

// ---------------------------------------------------------------------------
// Part B — CashGo: upsert into daily_txn_cashgo_entry, Sheet as source of
// truth, capped to the last 60 days and excluding today.
// ---------------------------------------------------------------------------

async function backfillCashgo(): Promise<{ upserted: number; rejected: number; outOfWindow: number }> {
  const rows = await fetchRange('CashGo!A2:F');
  let upserted = 0;
  let rejected = 0;
  let outOfWindow = 0;

  for (const row of rows) {
    const rawDate = cleanText(row[1]);
    if (!rawDate) continue; // fully blank row
    const businessDate = parseCashGoDate(rawDate);
    if (!businessDate) {
      rejected++;
      continue;
    }
    if (businessDate < WINDOW_START_KEY || businessDate >= TODAY_KEY) {
      outOfWindow++;
      continue;
    }
    const metrics: [string, number | null, number | null][] = [
      ['bkash', parseQuotaAmount(row[2]), cleanNumber(row[4])],
      ['nagad', parseQuotaAmount(row[3]), cleanNumber(row[5])],
    ];
    for (const [channel, target, process] of metrics) {
      if (target === null && process === null) continue; // truly blank cell pair, nothing to write
      const values = {
        target: target === null ? null : String(target),
        process: process === null ? null : String(process),
        updatedAt: new Date(),
      };
      await db
        .insert(schema.dailyTxnCashgoEntry)
        .values({ businessDate, channel, ...values })
        .onConflictDoUpdate({
          target: [schema.dailyTxnCashgoEntry.businessDate, schema.dailyTxnCashgoEntry.channel],
          set: values,
        });
      upserted++;
    }
  }
  return { upserted, rejected, outOfWindow };
}

async function main() {
  console.log('\n=== Part A: Settlement + Top Up ===');
  console.log('Wiping wallet_transactions (all rows, both products)...');
  await db.delete(schema.walletTransactions);

  for (const product of ['cashout', 'sendmoney'] as Product[]) {
    const result = await backfillWalletTransactions(product);
    console.log(`  ${product}: inserted ${result.inserted}, rejected ${result.rejected}, outside window ${result.outOfWindow}`);
  }

  console.log('\n=== Part B: CashGo ===');
  const cashgoResult = await backfillCashgo();
  console.log(`  daily_txn_cashgo_entry: upserted ${cashgoResult.upserted}, rejected ${cashgoResult.rejected}, outside window ${cashgoResult.outOfWindow}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
