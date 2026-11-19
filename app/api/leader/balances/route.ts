// Leader portal → Balance. Every shop under the signed-in leader (both
// products), with the same figures the Balance page computes
// (getAgentBalances), plus a total row. Scoped ONLY by session.leaderId —
// no leader/shop id is ever read from the request, so a leader can never
// see another leader's shops. SDP, frozen amount and the other internal
// columns are deliberately never sent.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { agents } from '@/app/lib/db/schema';
import { authorizeApi } from '@/app/lib/auth/guard';
import { getAgentBalances, type Product } from '@/app/lib/services/balanceService';

type LeaderBalanceRow = {
  agentId: number;
  agentCode: string;
  product: Product;
  companyBalance: number;
  openingBalance: number;
  totalDp: number;
  totalWd: number;
  totalTopUp: number;
  totalSettlement: number;
};

const FIELDS = ['companyBalance', 'openingBalance', 'totalDp', 'totalWd', 'totalTopUp', 'totalSettlement'] as const;

export async function GET(request: NextRequest) {
  const auth = await authorizeApi(request, ['tickets.raise']);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;
  if (!session.leaderId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const own = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.leaderId, session.leaderId));
  const ownIds = new Set(own.map((a) => a.id));

  const products: Product[] = ['cashout', 'sendmoney'];
  const perProduct = await Promise.all(products.map((p) => getAgentBalances(p)));

  const rows: LeaderBalanceRow[] = [];
  perProduct.forEach((list, i) => {
    for (const a of list) {
      if (!ownIds.has(a.agentId)) continue;
      rows.push({
        agentId: a.agentId,
        agentCode: a.agentCode,
        product: products[i],
        companyBalance: a.companyBalance,
        openingBalance: a.openingBalance,
        totalDp: a.totalDp,
        totalWd: a.totalWd,
        totalTopUp: a.totalTopUp,
        totalSettlement: a.totalSettlement,
      });
    }
  });
  rows.sort((a, b) => b.companyBalance - a.companyBalance || a.agentCode.localeCompare(b.agentCode));

  const total = Object.fromEntries(FIELDS.map((f) => [f, rows.reduce((s, r) => s + (r[f] || 0), 0)])) as Record<(typeof FIELDS)[number], number>;

  return NextResponse.json({ rows, total, shopCount: rows.length }, { headers: { 'Cache-Control': 'no-store' } });
}
