// PostgreSQL read-layer mirror of "AG BD STLM + TOPUP" / "PS BD STLM +
// TOPUP" reads (fetchRange, via /api/agstlmtopup and
// /api/sendmoney/stlmtopup). NOT wired into any page or route.
//
// Output shape: string[][] with the real confirmed header row + one row per
// ORIGINAL sheet row, 12 columns wide (A-L), reconstructed using each
// transaction's own `source_row_ref` (format "{product}:{topup|settlement}
// :{sheetRowNumber}", set by migrate-data.ts's importWalletTransactions())
// to place it back at its exact original row position — a topup and a
// settlement transaction that happened to share the same source row are
// re-merged into one output row, same as the real sheet.
//
// The "Type" column (index 5 / 11) is NOT stored anywhere in
// wallet_transactions (documented as unused by the migration script) and
// real sample values vary well beyond a simple topup/settlement label
// (e.g. "SDP TO MC", "STLM TO MC") — left '' rather than guessed.
// Settlement amounts are restored to the sheet's own negative-sign
// convention (Postgres stores abs(amount), sign implied by
// transaction_type) — Top Up stays positive, matching both products.
//
// Rows that were rejected during migration (bad date/amount/no matching
// agent) cannot be reconstructed — a known, already-disclosed gap from the
// original migration report, not something new here.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

const CASHOUT_HEADER = ['', 'To Agent', 'Amount', 'Date', 'Wallet', 'Type', '', 'To Agent', 'Amount', 'Date', 'Wallet', 'Type'];
const SENDMONEY_HEADER = ['', 'To Agent', 'Amount', 'Date', 'Wallet', 'TYPE', '', 'To Agent', 'Amount', 'Date', 'Wallet', 'TYPE'];

// "YYYY-MM-DD" (Postgres `date`) -> "M/D/YYYY" (sheet's own convention,
// reverses scripts/migrate-data.ts's parseSlashDate()).
function toSlashDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

export async function readStlmTopupPg(product: Product): Promise<string[][]> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
      occurredOn: schema.walletTransactions.occurredOn,
      remarks: schema.walletTransactions.remarks,
      sourceRowRef: schema.walletTransactions.sourceRowRef,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
    .where(eq(schema.walletTransactions.product, product));

  const byRowNumber = new Map<number, string[]>();
  const width = 12;
  for (const r of rows) {
    const match = r.sourceRowRef?.match(/:(\d+)$/);
    if (!match) continue; // no traceable original row — cannot be positioned, skip
    const rowNumber = parseInt(match[1], 10);
    if (!byRowNumber.has(rowNumber)) byRowNumber.set(rowNumber, new Array(width).fill(''));
    const out = byRowNumber.get(rowNumber)!;
    if (r.transactionType === 'topup') {
      out[1] = r.agentCode;
      out[2] = r.amount; // stored positive already
      out[3] = toSlashDate(r.occurredOn);
      out[4] = r.wallet ?? '';
    } else {
      out[7] = r.agentCode;
      out[8] = `-${r.amount}`; // sheet stores settlement negative
      out[9] = toSlashDate(r.occurredOn);
      out[10] = r.wallet ?? '';
      if (r.remarks) out[11] = r.remarks;
    }
  }

  const sortedRowNumbers = [...byRowNumber.keys()].sort((a, b) => a - b);
  const header = product === 'cashout' ? CASHOUT_HEADER : SENDMONEY_HEADER;
  return [header, ...sortedRowNumbers.map((n) => byRowNumber.get(n)!)];
}
