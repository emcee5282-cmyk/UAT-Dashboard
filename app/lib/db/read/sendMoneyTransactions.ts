// Dashboard's Bundle Transfer Trend chart (Send Money) + both products'
// Wallet Summary Top Up/Settlement columns all need a wider window than
// transactionPageService.ts's getSettlementRows/getTopUpRows provide (those
// are hardcoded to yesterday-only, sized for the Settlement/Top Up list
// pages) — this reads the same wallet_transactions table with a
// caller-supplied `sinceDate` instead, wide enough to cover the 30D trend
// view. Replaces the old Google-Sheets-sourced "PS BD STLM + TOPUP" (Send
// Money) / "AG BD STLM + TOPUP" (Cashout) fetches app/api/dashboard/
// route.ts used to read for this — both sync pipelines are disabled, so
// neither ever carried transactions entered after the Postgres migration
// went live.
//
// Originally Send-Money-only (function/file name predate the Cashout
// reuse) — `product` was added as a parameter rather than duplicating this
// file, since the query itself was already fully product-agnostic.
//
// `wallet` here is Postgres's own directly-stored per-transaction wallet
// (Bkash/Nagad/Rocket/Upay), not re-derived from the agent code's suffix
// the way the old sheet-reading code had to.
import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

export type SendMoneyTransactionRow = {
  transactionType: 'topup' | 'settlement';
  amount: number; // always positive; sign is implied by transactionType, same convention as wallet_transactions itself
  wallet: string | null;
  occurredOn: string; // 'YYYY-MM-DD'
  agentCode: string;
};

export async function getSendMoneyTransactionsSince(product: Product, sinceDate: string): Promise<SendMoneyTransactionRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      transactionType: schema.walletTransactions.transactionType,
      amount: schema.walletTransactions.amount,
      wallet: schema.walletTransactions.wallet,
      occurredOn: schema.walletTransactions.occurredOn,
      agentCode: schema.agents.agentCode,
    })
    .from(schema.walletTransactions)
    .innerJoin(schema.agents, eq(schema.walletTransactions.agentId, schema.agents.id))
    .where(and(eq(schema.walletTransactions.product, product), gte(schema.walletTransactions.occurredOn, sinceDate)));

  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}
