import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { tickets } from '@/app/lib/db/schema';
import { authorizeApi } from '@/app/lib/auth/guard';
import { can, canSettleTicket, canViewQueueTicket } from '@/app/lib/auth/permissions';

// Explicit "I actually looked at this" signal, decoupled from GET
// /api/tickets/:id (which is read-only — see that route's own comment).
// The client calls this only when the person clicks into the reply
// textbox or clicks the message thread itself — never on page load, never
// from a poll tick, never on scroll. Same ownership rule as GET: leaders
// scoped to their own ticket, staff/admin can view any.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const ticketId = Number((await params).id);
  if (!Number.isInteger(ticketId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getDb();
  const isStaff = !can(session.permissions, 'tickets.raise');

  const [ticket] = await db.select({ createdBy: tickets.createdBy, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket || (isStaff ? !canViewQueueTicket(session.permissions, ticket.title) : ticket.createdBy !== session.userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // A read-only look (Supervisor, or Admin via the leader pages) doesn't
  // clear the unread marker for the team that actually handles the ticket.
  if (!isStaff || canSettleTicket(session.permissions, ticket.title)) {
    await db
      .update(tickets)
      .set(isStaff ? { staffLastViewedAt: new Date() } : { lastViewedAt: new Date() })
      .where(eq(tickets.id, ticketId));
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
