import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';

type Product = 'cashout' | 'sendmoney';

// Lowercased shop name -> agents.id, for every name a Settlement/Top Up
// row (upload, New, Edit) may use. Cashout follows Opening as the single
// source of truth (see shopDisplayName.ts): a shop Opening splits into
// per-wallet lines is ONLY reachable by those exact line names (e.g.
// "U-M1AG-L4-BITTER004-BK") — its bare agent_code ("BITTER004") is
// deliberately not a valid name — and a shop with no lines by its
// agent_code, which is what Opening shows for it. When two agents claim the
// same name (e.g. a stale duplicate whose agent_code IS a raw wallet string),
// a real Opening line beats a bare code and an active shop beats an inactive
// one. Send Money has no per-wallet split, so it stays agent_code only.
export async function loadShopNameToAgentId(product: Product): Promise<Map<string, number>> {
  const db = getDb();
  const agents = await db
    .select({ id: schema.agents.id, agentCode: schema.agents.agentCode, isActive: schema.agents.isActive })
    .from(schema.agents)
    .where(eq(schema.agents.product, product));

  const map = new Map<string, number>();
  if (product !== 'cashout') {
    for (const a of agents) map.set(a.agentCode.toLowerCase(), a.id);
    return map;
  }

  const lines = await db
    .select({ agentId: schema.openingWalletLines.agentId, rawAgentName: schema.openingWalletLines.rawAgentName })
    .from(schema.openingWalletLines)
    .innerJoin(schema.agents, eq(schema.openingWalletLines.agentId, schema.agents.id))
    .where(eq(schema.agents.product, product));
  const linesByAgent = new Map<number, string[]>();
  for (const l of lines) {
    if (!linesByAgent.has(l.agentId)) linesByAgent.set(l.agentId, []);
    linesByAgent.get(l.agentId)!.push(l.rawAgentName);
  }

  const priority = new Map<string, number>();
  const claim = (name: string, agentId: number, rank: number) => {
    const key = name.trim().toLowerCase();
    if (!key || (priority.get(key) ?? -1) >= rank) return;
    priority.set(key, rank);
    map.set(key, agentId);
  };
  for (const a of agents) {
    const own = linesByAgent.get(a.id);
    const active = a.isActive ? 1 : 0;
    if (own && own.length > 0) for (const raw of own) claim(raw, a.id, 2 + active);
    else claim(a.agentCode, a.id, active);
  }
  return map;
}
