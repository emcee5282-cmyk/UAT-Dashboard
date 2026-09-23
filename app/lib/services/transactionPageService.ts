// Phase 7 — dedicated PostgreSQL reads for the Settlement and Top Up pages
// (app/stlm, app/sendmoney/settlement, app/topup, app/sendmoney/topup).
// Same sibling relationship to transactionActionsService.ts (mutations) as
// openingPageService.ts has to openingActionsService.ts.
//
// Brand/Leader — Leader is read via a plain join onto agents.leader_id (a
// shop's leader doesn't vary transaction to transaction). Brand used to be
// read the same way, off agents.brand_id, on the theory that "a shop's
// brand doesn't change transaction to transaction in practice" — but that's
// exactly wrong for a shop uploaded under more than one brand: a row's own
// walletTransactions.brand_id (the file's actual uploaded Brand for THAT
// row, Phase 10 onward) is preferred, falling back to agents.brand_id only
// for pre-Phase-10 rows with no per-transaction brand of their own.
// Confirmed live bug otherwise: uploading a Settlement row tagged Brand=M1
// for a shop whose current agents.brand_id resolves to a different brand
// displayed that other brand instead of the uploaded M1.
//
// Bounded to occurred_on >= yesterday's business date (2 AM Manila
// rollover, same boundary the pages' own isToday()/isYesterday() already
// use) — the table holds months of history, but the pages only ever display
// today vs. yesterday, so there is no reason to pull more over the wire.
// isToday()/isYesterday() themselves are left completely untouched on the
// page side; this only narrows what reaches them.
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getBusinessToday, manilaFields } from '../businessDate';
import { getEffectiveBusinessToday } from './balanceService';

export type Product = 'cashout' | 'sendmoney';
export type TransactionType = 'settlement' | 'topup';
export type DateRange = { from: string; to: string }; // 'YYYY-MM-DD', inclusive, Manila

function yesterdayBoundaryIso(): string {
  const today = getBusinessToday();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const { year, month, day } = manilaFields(yesterday);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Plain 'YYYY-MM-DD' arithmetic — same UTC-anchored-noon trick used
// elsewhere in this codebase's own date-range scripts to sidestep DST/
// timezone drift entirely (there's no DST in Asia/Manila, but this keeps
// the string math trustworthy regardless of the server runtime's own TZ).
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86400000) + 1;
}

// The equal-length window immediately preceding [from, to] — the delta
// badge's "vs previous period" baseline.
function previousPeriod(from: string, to: string): DateRange {
  const length = daysBetweenInclusive(from, to);
  const prevTo = addDaysIso(from, -1);
  const prevFrom = addDaysIso(prevTo, -(length - 1));
  return { from: prevFrom, to: prevTo };
}

// Resolves the caller-supplied (optional) range against this product's
// "Effective Today" (see getEffectiveBusinessToday's own header comment —
// gated on that day's Estimated Opening actually existing, not raw
// wall-clock). No range supplied -> defaults to today only, exactly
// preserving pre-range-filter behavior. A supplied `to` later than
// effective-today is clamped down to it rather than rejected — a stale
// client shouldn't be able to request into a day that isn't "today" yet.
async function resolveDateRange(product: Product, range?: DateRange): Promise<DateRange & { today: string }> {
  const today = await getEffectiveBusinessToday(product);
  if (!range) return { from: today, to: today, today };
  const to = range.to > today ? today : range.to;
  const from = range.from > to ? to : range.from;
  return { from, to, today };
}

// Reverses the DB's 'YYYY-MM-DD' storage back into the pages' own
// 'M/D/YYYY' convention (no leading zeros) — matches how these rows were
// always shaped when read straight from the sheet, so isToday()/
// isYesterday()/formatDateDisplay() on the page side need no changes.
function toSlashDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

type RawRow = {
  id: number;
  agentCode: string;
  amount: string;
  wallet: string | null;
  occurredOn: string;
  remarks: string | null;
  leaderName: string | null;
  brandCode: string | null;
};

const txnBrand = alias(schema.brands, 'txn_brand');
const agentBrand = alias(schema.brands, 'agent_brand');

async function getTransactionRowsRaw(product: Product, transactionType: TransactionType, range?: DateRange): Promise<RawRow[]> {
  const db = getDb();
  const dateFilter = range
    ? and(gte(schema.walletTransactions.occurredOn, range.from), lte(schema.walletTransactions.occurredOn, range.to))
    : gte(schema.walletTransactions.occurredOn, yesterdayBoundaryIso());

  return db
    .select({
      id: schema.walletTransactions.id,
      agentCode: schema.agents.agentCode,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
      occurredOn: schema.walletTransactions.occurredOn,
      remarks: schema.walletTransactions.remarks,
      leaderName: schema.leaders.name,
      brandCode: sql<string | null>`coalesce(${txnBrand.code}, ${agentBrand.code})`,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(txnBrand, eq(schema.walletTransactions.brandId, txnBrand.id))
    .leftJoin(agentBrand, eq(schema.agents.brandId, agentBrand.id))
    .where(and(
      eq(schema.walletTransactions.product, product),
      eq(schema.walletTransactions.transactionType, transactionType),
      dateFilter
    ));
}

// Lightweight aggregate (no row payload) — the delta badge's "previous
// period" baseline never needs to reach the client as rows, just a total
// and a count.
async function getTransactionRangeSummary(product: Product, transactionType: TransactionType, range: DateRange): Promise<{ total: number; count: number }> {
  const db = getDb();
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${schema.walletTransactions.amount}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.walletTransactions)
    .where(and(
      eq(schema.walletTransactions.product, product),
      eq(schema.walletTransactions.transactionType, transactionType),
      gte(schema.walletTransactions.occurredOn, range.from),
      lte(schema.walletTransactions.occurredOn, range.to)
    ));
  return { total: parseFloat(row?.total ?? '0'), count: row?.count ?? 0 };
}

// Distinct Manila business dates that have at least one row — powers the
// date-range popover's calendar (disabled = not in this list) and Quick
// Select presets (disabled if none of their days are in this list).
export async function getAvailableTransactionDates(product: Product, transactionType: TransactionType): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ occurredOn: schema.walletTransactions.occurredOn })
    .from(schema.walletTransactions)
    .where(and(
      eq(schema.walletTransactions.product, product),
      eq(schema.walletTransactions.transactionType, transactionType)
    ));
  return rows.map((r) => r.occurredOn).sort();
}

export type SettlementPgRow = {
  id: number;
  agentName: string;
  amount: string;
  remarks: string;
  date: string;
  wallet: string;
  brand: string;
  leader: string;
};

export type TransactionPageData<Row> = {
  rows: Row[];
  total: number;
  count: number;
  previousPeriodTotal: number;
  previousPeriodCount: number;
  today: string; // Effective Today (see getEffectiveBusinessToday) — the client never computes "today" itself
  from: string;
  to: string;
};

export async function getSettlementRows(product: Product, range?: DateRange): Promise<SettlementPgRow[]> {
  const rows = await getTransactionRowsRaw(product, 'settlement', range);
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agentCode,
    amount: r.amount,
    remarks: r.remarks ?? '',
    date: toSlashDate(r.occurredOn),
    wallet: r.wallet ?? '',
    brand: r.brandCode ?? '−',
    leader: r.leaderName ?? '−',
  }));
}

// Orchestrates a full page load: resolves the requested range against
// Effective Today, fetches the range's own rows (current-period total/count
// reduced from them, same math the pages already did client-side), and a
// separate lightweight aggregate for the equal-length prior period (never
// fetches that period's full row set).
export async function getSettlementPageData(product: Product, range?: DateRange): Promise<TransactionPageData<SettlementPgRow>> {
  const resolved = await resolveDateRange(product, range);
  const rows = await getSettlementRows(product, resolved);
  const total = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
  const prevSummary = await getTransactionRangeSummary(product, 'settlement', previousPeriod(resolved.from, resolved.to));
  return { rows, total, count: rows.length, previousPeriodTotal: prevSummary.total, previousPeriodCount: prevSummary.count, today: resolved.today, from: resolved.from, to: resolved.to };
}

export type TopUpPgRow = {
  id: number;
  agentName: string;
  wallet: string;
  amount: string;
  date: string;
  type: string;
  leader: string;
  brand: string;
};

// Bug fix — Top Up's "Type" IS stored per-row now (importService.ts's
// importTopUpFile writes the uploaded value into the same `remarks` column
// Settlement's free-text Remarks already uses; transactionActionsService.ts's
// updateTransactions/createTransaction do too). This fixed-per-product
// literal is now only a FALLBACK, for historical rows written before that
// fix (remarks NULL there) — those still show the one label the old,
// now-disabled Sheets-sync pipeline always implied for the whole product,
// rather than showing blank.
const TOPUP_TYPE_LABEL: Record<Product, string> = {
  cashout: 'BUNDLE TRANSFER',
  sendmoney: 'INTERNAL TRANSFER',
};

export async function getTopUpRows(product: Product, range?: DateRange): Promise<TopUpPgRow[]> {
  const rows = await getTransactionRowsRaw(product, 'topup', range);
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agentCode,
    wallet: r.wallet ?? '',
    amount: r.amount,
    date: toSlashDate(r.occurredOn),
    type: r.remarks ?? TOPUP_TYPE_LABEL[product],
    leader: r.leaderName ?? '−',
    brand: r.brandCode ?? '−',
  }));
}

export async function getTopUpPageData(product: Product, range?: DateRange): Promise<TransactionPageData<TopUpPgRow>> {
  const resolved = await resolveDateRange(product, range);
  const rows = await getTopUpRows(product, resolved);
  const total = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
  const prevSummary = await getTransactionRangeSummary(product, 'topup', previousPeriod(resolved.from, resolved.to));
  return { rows, total, count: rows.length, previousPeriodTotal: prevSummary.total, previousPeriodCount: prevSummary.count, today: resolved.today, from: resolved.from, to: resolved.to };
}

export type ExistingTransactionSignature = {
  agentCode: string;
  brandCode: string | null;
  wallet: string | null;
  amount: string;
  remarks: string | null; // Settlement's Remarks or Top Up's Type — same convention as everywhere else
  occurredOn: string; // 'YYYY-MM-DD'
  importedAt: string; // ISO — import_batches.uploadedAt, falling back to the row's own createdAt for manual entries
  importedBy: string; // import_batches.uploadedBy, falling back to 'Manual entry'
};

// Bulk Import's "already imported" duplicate check — a sibling of
// getTransactionRowsRaw above, but bounded to the exact set of dates
// actually present in an uploaded file (WHERE occurredOn IN (...), not a
// fixed "today") since a file can legitimately contain rows dated
// differently from each other — the whole point is comparing each row
// against existing records sharing THAT row's own date, not the day the
// file happens to be uploaded. importBatches is left-joined (nullable)
// because a manually-created record via createTransaction has no batch.
//
// Brand is joined via walletTransactions.brandId, NOT agents.brandId —
// deliberately diverging from getTransactionRowsRaw's join shape above.
// That function's header comment already discloses agents.brandId as an
// accepted approximation for page DISPLAY (a shop's brand rarely changes
// day to day). But the six-field duplicate signature this feeds
// (detectAlreadyImportedDuplicates) compares against each row's own
// UPLOADED Brand value, and Phase 10 gave every transaction its own
// brandId specifically because one shop can have transactions posted
// under more than one brand (computeFingerprint in importService.ts keys
// on it for the same reason). Joining through agents.brandId here would
// silently mismatch the signature for any transaction whose brand differs
// from that agent's current default — not a rare edge case, but the exact
// scenario the per-transaction brandId column exists to represent.
export async function getTransactionSignaturesForDates(
  product: Product,
  transactionType: TransactionType,
  occurredOnDates: string[]
): Promise<ExistingTransactionSignature[]> {
  if (occurredOnDates.length === 0) return [];
  const db = getDb();

  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      brandCode: schema.brands.code,
      wallet: schema.walletTransactions.wallet,
      amount: schema.walletTransactions.amount,
      remarks: schema.walletTransactions.remarks,
      occurredOn: schema.walletTransactions.occurredOn,
      batchUploadedAt: schema.importBatches.uploadedAt,
      batchUploadedBy: schema.importBatches.uploadedBy,
      createdAt: schema.walletTransactions.createdAt,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
    .leftJoin(schema.brands, eq(schema.walletTransactions.brandId, schema.brands.id))
    .leftJoin(schema.importBatches, eq(schema.walletTransactions.importBatchId, schema.importBatches.id))
    .where(and(
      eq(schema.walletTransactions.product, product),
      eq(schema.walletTransactions.transactionType, transactionType),
      inArray(schema.walletTransactions.occurredOn, occurredOnDates)
    ));

  return rows.map((r) => ({
    agentCode: r.agentCode,
    brandCode: r.brandCode,
    wallet: r.wallet,
    amount: r.amount,
    remarks: r.remarks,
    occurredOn: r.occurredOn,
    importedAt: (r.batchUploadedAt ?? r.createdAt).toISOString(),
    importedBy: r.batchUploadedBy ?? 'Manual entry',
  }));
}
