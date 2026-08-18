// Phase 7 — Settlement/Top Up row Actions (Edit / Bulk Edit / Delete / New)
// against PostgreSQL. Same conventions as openingActionsService.ts (its own
// mutation-focused sibling for Today's Opening):
//   - Reuses settlementValidation.ts's field checkers directly rather than
//     re-implementing a second, possibly-diverging set of rules — the same
//     functions the real upload path (importService.ts) already trusts.
//   - Single Edit and Bulk Edit are the SAME operation at different scale —
//     one id or many, always one transaction, always all-or-nothing.
//   - Brand is deliberately NOT an editable field here. wallet_transactions
//     has no brand column — brand is always derived from agents.brand_id
//     (the same canonical resolution Today's Opening/Agent Balance already
//     use), never stored per-transaction. This matches what the existing
//     (already-built) importSettlementFile/importTopUpFile silently assume:
//     neither ever writes a brand onto the inserted row. A `brand` value
//     submitted by the client is simply never read here.
//   - Bug fix — Top Up's "Type" used to be treated the same way (a fixed
//     literal, never stored), which meant editing/creating a Top Up record
//     silently dropped whatever Type the user picked. `remarks` is a
//     generic "6th descriptive field" column now — Settlement's free-text
//     Remarks and Top Up's closed-set Type both go through it, so the
//     `transactionType === 'settlement'` gate that used to scope it to
//     Settlement only is gone. No extra enum validation is added here for
//     Top Up's Type — the caller's own RecordFormModal already enforces the
//     closed set (required, TOPUP_TYPE_OPTIONS) before Save is reachable.
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { checkWalletField, checkAmountField, checkDateField, parseImportDate } from '../settlementValidation';
import { parseAmount } from '../format';

export type Product = 'cashout' | 'sendmoney';
export type TransactionType = 'settlement' | 'topup';

const WALLET_OPTIONS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY'];

export class TransactionActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Reuses checkDateField's own rules (required, parseable, no future dates —
// same "no concrete reason to differ" gate the bulk-import path already
// enforces) instead of a second, looser check for manual entry.
function toStorageDate(display: string): string {
  const result = checkDateField(display);
  if (result) throw new TransactionActionError(result.message, 400);
  const parsed = parseImportDate(display)!;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

async function resolveAgentId(product: Product, agentName: string): Promise<number> {
  const db = getDb();
  const trimmed = agentName.trim();
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.product, product), sql`lower(${schema.agents.agentCode}) = lower(${trimmed})`));
  if (!agent) throw new TransactionActionError(`Agent "${agentName}" not found in the roster.`, 400);
  return agent.id;
}

export type TransactionFieldUpdates = {
  agentName?: string; // re-points the row to a different agent (validated against the roster)
  wallet?: string;
  amount?: string;
  remarks?: string; // Settlement's free-text Remarks, or Top Up's Type — same column, meaning implied by transactionType
  date?: string; // 'M/D/YYYY', matching the page's own existing storage convention
};

export async function updateTransactions(
  product: Product,
  transactionType: TransactionType,
  ids: number[],
  updates: TransactionFieldUpdates
): Promise<{ updatedCount: number }> {
  if (ids.length === 0) throw new TransactionActionError('No records specified.', 400);

  if (updates.wallet !== undefined) {
    const result = checkWalletField(updates.wallet, { walletOptions: WALLET_OPTIONS });
    if (result) throw new TransactionActionError(result.message, 400);
  }
  if (updates.amount !== undefined) {
    const result = checkAmountField(updates.amount);
    if (result) throw new TransactionActionError(result.message, 400);
  }
  const storageDate = updates.date !== undefined ? toStorageDate(updates.date) : undefined;

  const db = getDb();
  let updatedCount = 0;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.walletTransactions.id })
      .from(schema.walletTransactions)
      .where(and(
        eq(schema.walletTransactions.product, product),
        eq(schema.walletTransactions.transactionType, transactionType),
        inArray(schema.walletTransactions.id, ids)
      ));

    const foundIds = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new TransactionActionError(`Record(s) not found, no changes were made: ${missing.join(', ')}`, 404);
    }

    const agentId = updates.agentName !== undefined ? await resolveAgentId(product, updates.agentName) : undefined;

    const setValues: Partial<typeof schema.walletTransactions.$inferInsert> = {};
    if (agentId !== undefined) setValues.agentId = agentId;
    if (updates.wallet !== undefined) setValues.wallet = updates.wallet;
    if (updates.amount !== undefined) setValues.amount = parseAmount(updates.amount).toFixed(2);
    if (storageDate !== undefined) setValues.occurredOn = storageDate;
    if (updates.remarks !== undefined) setValues.remarks = updates.remarks || null;

    if (Object.keys(setValues).length > 0) {
      await tx.update(schema.walletTransactions).set(setValues).where(inArray(schema.walletTransactions.id, ids));
    }
    updatedCount = ids.length;
  });

  return { updatedCount };
}

export type NewTransaction = {
  agentName: string;
  wallet: string;
  amount: string;
  date: string; // 'M/D/YYYY'
  remarks?: string; // Settlement's free-text Remarks, or Top Up's Type — same column, meaning implied by transactionType
};

// "New Settlement/Top Up Record" — a real INSERT. No fingerprint/duplicate
// check is applied here (that mechanism belongs to the bulk-import pipeline,
// see importService.ts's insertTransactionRows) — a manually-added single
// record is deliberately trusted as intentional, same as how Today's
// Opening's own createOpeningAgent never runs a dedup check either.
export async function createTransaction(product: Product, transactionType: TransactionType, input: NewTransaction): Promise<{ id: number }> {
  const agentName = (input.agentName ?? '').trim();
  if (!agentName) throw new TransactionActionError('Agent Name is required.', 400);

  const walletCheck = checkWalletField(input.wallet, { walletOptions: WALLET_OPTIONS });
  if (walletCheck) throw new TransactionActionError(walletCheck.message, 400);
  const amountCheck = checkAmountField(input.amount);
  if (amountCheck) throw new TransactionActionError(amountCheck.message, 400);
  const storageDate = toStorageDate(input.date);

  const db = getDb();
  let insertedId = 0;

  await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.product, product), sql`lower(${schema.agents.agentCode}) = lower(${agentName})`));
    if (!agent) throw new TransactionActionError(`Agent "${input.agentName}" not found in the roster.`, 400);

    const [inserted] = await tx.insert(schema.walletTransactions).values({
      product,
      agentId: agent.id,
      transactionType,
      amount: parseAmount(input.amount).toFixed(2),
      wallet: input.wallet || null,
      occurredOn: storageDate,
      remarks: input.remarks || null,
    }).returning({ id: schema.walletTransactions.id });
    insertedId = inserted.id;
  });

  return { id: insertedId };
}

// Hard-delete. wallet_transactions' only self-referencing FK is
// flaggedDuplicateOfId (a later row flagged, at import time, as a duplicate
// of this one) — that flag is informational metadata about where a
// duplicate warning originated during Bulk Import's review step, not a
// protected relationship like a transaction tied to a wallet balance. A
// user can always delete any transaction record; any other row pointing at
// this one via flaggedDuplicateOfId just has that pointer cleared as part
// of the same delete, rather than the delete being refused.
export async function deleteTransaction(product: Product, transactionType: TransactionType, id: number): Promise<{ deleted: true }> {
  const db = getDb();

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: schema.walletTransactions.id })
      .from(schema.walletTransactions)
      .where(and(
        eq(schema.walletTransactions.id, id),
        eq(schema.walletTransactions.product, product),
        eq(schema.walletTransactions.transactionType, transactionType)
      ));
    if (!row) throw new TransactionActionError('Record not found.', 404);

    await tx.update(schema.walletTransactions)
      .set({ flaggedDuplicateOfId: null })
      .where(eq(schema.walletTransactions.flaggedDuplicateOfId, id));

    await tx.delete(schema.walletTransactions).where(eq(schema.walletTransactions.id, id));
  });

  return { deleted: true };
}
