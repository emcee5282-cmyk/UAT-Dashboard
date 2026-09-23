import { NextRequest, NextResponse } from 'next/server';
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { agents, leaders, ticketMessages, tickets, users } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

// Ticket detail + full message thread. Leaders are scoped to their own
// ticket only; staff/admin can view any ticket (cross-leader queue — admin
// now shares the staff queue, see middleware.ts). Returns 404 (not 403)
// whenever access isn't allowed — same response as a nonexistent id, so a
// caller can't probe which ticket ids exist by watching for a different
// error code.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || (session.role !== 'leader' && session.role !== 'staff' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ticketId = Number((await params).id);
  if (!Number.isInteger(ticketId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getDb();
  const isStaff = session.role === 'staff' || session.role === 'admin';

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket || (!isStaff && ticket.createdBy !== session.userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const agentAndShopIds = [...(ticket.agentIds ?? []), ...(ticket.shopIds ?? [])];
  const resolvedAgents =
    agentAndShopIds.length > 0
      ? await db.select({ id: agents.id, agentCode: agents.agentCode }).from(agents).where(inArray(agents.id, agentAndShopIds))
      : [];
  const agentById = new Map(resolvedAgents.map((a) => [a.id, a.agentCode]));

  let leaderName: string | null = null;
  let submittedByUsername: string | null = null;
  if (isStaff) {
    const [submitter] = await db
      .select({ username: users.username, leaderName: leaders.name })
      .from(users)
      .leftJoin(leaders, eq(users.leaderId, leaders.id))
      .where(eq(users.id, ticket.createdBy))
      .limit(1);
    leaderName = submitter?.leaderName ?? null;
    submittedByUsername = submitter?.username ?? null;
  }

  const rawMessages = await db
    .select()
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, ticketId))
    .orderBy(asc(ticketMessages.createdAt));

  // A leader must never learn which staff member claimed their ticket —
  // redacted here, server-side, so the name never leaves in the JSON
  // response at all (not just hidden by the client's render logic, which a
  // network-tab inspection would defeat). Staff/admin get the row as-is,
  // now including a resolved senderName (for the message-bubble avatar/name
  // treatment) — gated behind the same isStaff check as everything else on
  // this redaction boundary, so a leader caller never receives it either.
  let messages;
  if (isStaff) {
    const senderIds = [...new Set(rawMessages.filter((m) => m.senderRole !== 'system').map((m) => m.senderId))];
    const senderUsers =
      senderIds.length > 0 ? await db.select({ id: users.id, name: users.name, username: users.username }).from(users).where(inArray(users.id, senderIds)) : [];
    const senderNameById = new Map(senderUsers.map((u) => [u.id, u.name || u.username]));
    messages = rawMessages.map((m) => ({ ...m, senderName: m.senderRole === 'system' ? null : (senderNameById.get(m.senderId) ?? null) }));
  } else {
    messages = rawMessages.map((m) => (m.kind === 'assigned' ? { ...m, message: 'This ticket has been assigned.' } : m));
  }

  // Deliberately no "mark as viewed" write here anymore — this endpoint is
  // read-only (it's what polling calls every few seconds). Viewing is now
  // an explicit act, see POST /api/tickets/:id/view, fired only when the
  // person actually clicks/focuses the reply textbox or message thread.

  return NextResponse.json(
    {
      ticket: {
        ...ticket,
        agentCodes: (ticket.agentIds ?? []).map((id) => agentById.get(id) ?? String(id)),
        shopCodes: (ticket.shopIds ?? []).map((id) => agentById.get(id) ?? String(id)),
        ...(isStaff ? { leaderName, submittedByUsername } : {}),
      },
      messages,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
