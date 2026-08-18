// PostgreSQL read-layer mirror of the "SSP AG BalanceLimit" / "SSP PS
// BalanceLimit" reads (fetchBalanceLimitRows() for Cashout, fetchRange('SSP
// PS BalanceLimit') for Send Money). NOT wired into any page or route.
//
// Output shape: string[][] with a synthetic header row (matching the real
// sheet's own confirmed header text) + one data row per agent_wallets row,
// 17 columns wide (A-Q) to match the real sheet's column count. Only the 8
// columns real dashboard code actually reads are populated from Postgres
// data (Wallet Name, Account Status, Bank, Group, Balance, Total DP, Total
// WD, Login — the exact same indices app/agentbal, app/sendmoney/balances,
// and migrate-data.ts's own importAgentWallets() all use). Every other
// column (Reference, Channel, Account, Balance Limit, DP Limit, WD Limit,
// Update Time, Status, and Send Money's Remaining MonthlyLimit) was never
// migrated into agent_wallets and is intentionally left '' rather than
// guessed — a known, documented gap (see the read-layer plan).
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

const CASHOUT_HEADER = [
  'Reference', 'Wallet Name', 'Account Status', '', 'Bank', 'Channel', 'Group',
  'Account', 'Balance', 'Balance Limit', 'DP Limit', 'Total DP', 'WD Limit',
  'Total WD', 'Update Time', 'Login', 'Status',
];
const SENDMONEY_HEADER = [
  'Wallet Name', 'Account Status', 'Remaining MonthlyLimit', '', 'Bank', 'Channel', 'Group',
  'Account', 'Balance', 'Balance Limit', 'DP Limit', 'Total DP', 'WD Limit',
  'Total WD', 'Update Time', 'Login', 'Status',
];

function cell(val: string | null): string {
  return val ?? '';
}

// Reverses resolveWalletTypeCode() from scripts/migrate-data.ts — Cashout's
// Bank cell is the bare code as-is; Send Money's carries a trailing "C"
// that was stripped before storage, so it's restored here.
function walletTypeCodeToBankCell(product: Product, code: string | null): string {
  if (!code) return '';
  return product === 'sendmoney' ? `${code}C` : code;
}

export async function readBalanceLimitPg(product: Product): Promise<string[][]> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      accountStatus: schema.agentWallets.accountStatus,
      walletTypeCode: schema.walletTypes.code,
      groupCode: schema.agentWallets.groupCode,
      balance: schema.agentWallets.balance,
      totalDp: schema.agentWallets.totalDp,
      totalWd: schema.agentWallets.totalWd,
      isLoggedIn: schema.agentWallets.isLoggedIn,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(eq(schema.agents.product, product));

  const header = product === 'cashout' ? CASHOUT_HEADER : SENDMONEY_HEADER;
  const bankCell = (code: string | null) => walletTypeCodeToBankCell(product, code);

  const dataRows = rows.map((r) => {
    const login = r.isLoggedIn ? 'Yes' : 'No';
    if (product === 'cashout') {
      return ['', r.agentCode, cell(r.accountStatus), '', bankCell(r.walletTypeCode), '', cell(r.groupCode), '', cell(r.balance), '', '', cell(r.totalDp), '', cell(r.totalWd), '', login, ''];
    }
    return [r.agentCode, cell(r.accountStatus), '', '', bankCell(r.walletTypeCode), '', cell(r.groupCode), '', cell(r.balance), '', '', cell(r.totalDp), '', cell(r.totalWd), '', login, ''];
  });

  return [header, ...dataRows];
}
