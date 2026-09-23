// Leader-scoped agent lookup for the Create Ticket flow (app/tickets/create).
// Serves BOTH the Agent concern "Agent ID" search and the Shop replacement
// "Shop" search — in this app's data model a shop IS an agent (see
// schema.ts), so there's one real dataset behind both UI labels.
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { agents } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

export async function GET(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || session.role !== 'leader' || !session.leaderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
  // No `q` is the common case here: the create-ticket form fetches a
  // leader's whole roster once and filters it client-side (matching the
  // mockup's own in-memory substring filter exactly, keystroke by
  // keystroke, no per-keystroke round trip). Deliberately no LIMIT — this
  // is always scoped to one leader's own roster (agents.leaderId is
  // indexed), and real rosters run up to ~4,900 today; a hardcoded cap
  // here previously truncated a large leader's roster silently (some of
  // their real agents would just never appear in search).
  const db = getDb();
  const rows = await db
    .select({ id: agents.id, agentCode: agents.agentCode, product: agents.product })
    .from(agents)
    .where(
      and(
        eq(agents.leaderId, session.leaderId),
        eq(agents.isActive, true),
        q ? ilike(agents.agentCode, `%${q}%`) : undefined
      )
    )
    .orderBy(agents.agentCode);

  return NextResponse.json({ agents: rows });
}
