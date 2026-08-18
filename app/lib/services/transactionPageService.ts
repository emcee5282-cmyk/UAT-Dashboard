// Phase 7 — dedicated PostgreSQL reads for the Settlement and Top Up pages
// (app/stlm, app/sendmoney/settlement, app/topup, app/sendmoney/topup).
// Same sibling relationship to transactionActionsService.ts (mutations) as
// openingPageService.ts has to openingActionsService.ts.
//
// Brand/Leader are read via a plain join onto agents.brand_id/leader_id —
// the same canonical resolution Today's Opening/Agent Balance already use —
// rather than re-deriving the live sheet's per-transaction brand-suffix
// override (never captured anywhere in wallet_transactions, and not
// something the already-built import pipeline stores either). A shop's
// brand doesn't change transaction to transaction in practice, so this is
// expected to be behaviorally equivalent; the one disclosed divergence is
// documented in transactionActionsService.ts's own header comment.
//
// Bounded to occurred_on >= yesterday's business date (2 AM Manila
// rollover, same boundary the pages' own isToday()/isYesterday() already
// use) — the table holds months of history, but the pages only ever display
// today vs. yesterday, so there is no reason to pull more over the wire.
// isToday()/isYesterday() themselves are left completely untouched on the
// page side; this only narrows what reaches them.
import { eq, and, gte, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getBusinessToday, manilaFields } from '../businessDate';

export type Product = 'cashout' | 'sendmoney';
export type TransactionType = 'settlement' | 'topup';

function yesterdayBoundaryIso(): string {
  const today = getBusinessToday();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const { year, month, day } = manilaFields(yesterday);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

async function getTransactionRowsRaw(product: Product, transactionType: TransactionType): Promise<RawRow[]> {
  const db = getDb();
  const boundary = yesterdayBoundaryIso();

  return db
    .select({
      id: schema.walletTransactions.id,
      agentCode: schema.agents.agentCode,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
      occurredOn: schema.walletTransactions.occurredOn,
      remarks: schema.walletTransactions.remarks,
      leaderName: schema.leaders.name,
      brandCode: schema.brands.code,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .leftJoin(schema.brands, eq(schema.agents.brandId, schema.brands.id))
    .where(and(
      eq(schema.walletTransactions.product, product),
      eq(schema.walletTransactions.transactionType, transactionType),
      gte(schema.walletTransactions.occurredOn, boundary)
    ));
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

export async function getSettlementRows(product: Product): Promise<SettlementPgRow[]> {
  const rows = await getTransactionRowsRaw(product, 'settlement');
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

export async function getTopUpRows(product: Product): Promise<TopUpPgRow[]> {
  const rows = await getTransactionRowsRaw(product, 'topup');
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
