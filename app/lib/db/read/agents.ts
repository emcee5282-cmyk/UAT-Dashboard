// PostgreSQL read-layer mirror of the "Opening AG" roster reads
// (fetchRange('Opening AG!A2:D') for Cashout, 'Opening AG!L2:O' for Send
// Money). NOT wired into any page or API route — Google Sheets remains the
// active read source. This exists so a future, explicit switch-over has a
// tested, drop-in-shaped replacement ready.
//
// Output shape: string[][] rows, NO header (matches the real reader, which
// starts at row 2), columns [agentCode, openingBalance, sdp, leaderName] —
// exactly the 4 columns real consumers (app/agentbal, app/summary,
// app/sendmoney/*, etc.) read via row[0..3]. Blank cells are '' (matches
// Sheets' own blank-cell convention via fetchRange), not '-' (that's the
// app layer's own rawVal() convention, applied by the callers themselves,
// not by the raw reader).
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

function numToCell(val: string | null): string {
  return val ?? '';
}

export async function readOpeningRosterPg(product: Product): Promise<string[][]> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      openingBalance: schema.agents.openingBalance,
      sdp: schema.agents.sdp,
      leaderName: schema.leaders.name,
    })
    .from(schema.agents)
    .leftJoin(schema.leaders, eq(schema.agents.leaderId, schema.leaders.id))
    .where(eq(schema.agents.product, product));

  return rows.map((r) => [r.agentCode, numToCell(r.openingBalance), numToCell(r.sdp), r.leaderName ?? '']);
}
