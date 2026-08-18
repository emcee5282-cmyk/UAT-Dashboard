// PostgreSQL read-layer mirror of "Dashboard Overview" reads (/api/sheet
// for Cashout's B3:I8 block, /api/sendmoney/sheet for Send Money's B11:I16
// block). NOT wired into any page or route.
//
// Output shape: header + 5 data rows (TOTAL/BKASH/NAGAD/ROCKET/UPAY),
// matching the real confirmed header text per product (Send Money's own
// sheet genuinely labels column C "Total PayOut", not "Total WD"). The
// sheet's "BD-Transfer IN"/"STLM & BD Transfer Out" columns are
// reconstructed as '0' — not a guess, dashboard_manual_balances's own
// schema comment confirms these are always seeded at 0 in-sheet and never
// trusted by the app, which is exactly why they were never migrated.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

const CASHOUT_HEADER = ['Wallet', 'Total DP', 'Total WD', 'BD-Transfer IN', 'STLM & BD Transfer Out', 'Balance Inside Wallet', 'Running Bal.', 'Opening Balance'];
const SENDMONEY_HEADER = ['Wallet', 'Total DP', 'Total PayOut', 'BD-Transfer IN', 'STLM & BD Transfer Out', 'Balance Inside Wallet', 'Running Bal.', 'Opening Balance'];

const WALLET_ORDER = ['TOTAL', 'BKASH', 'NAGAD', 'ROCKET', 'UPAY'];

function cell(val: string | null): string {
  return val ?? '';
}

export async function readDashboardManualBalancesPg(product: Product): Promise<string[][]> {
  const db = getDb();
  const rows = await db.select().from(schema.dashboardManualBalances).where(eq(schema.dashboardManualBalances.product, product));
  const byWallet = new Map(rows.map((r) => [r.wallet, r]));

  const header = product === 'cashout' ? CASHOUT_HEADER : SENDMONEY_HEADER;
  const dataRows = WALLET_ORDER.map((wallet) => {
    const r = byWallet.get(wallet);
    if (!r) return [wallet, '', '', '0', '0', '', '', ''];
    return [wallet, cell(r.totalDp), cell(r.totalWd), '0', '0', cell(r.actualBalance), cell(r.runningBalance), cell(r.openingBalance)];
  });

  return [header, ...dataRows];
}
