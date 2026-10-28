import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { ticketMessages, tickets } from '@/app/lib/db/schema';
import { authorizeApi } from '@/app/lib/auth/guard';
import { canSettleTicket } from '@/app/lib/auth/permissions';

// Staff/admin-only (admin now shares the staff queue, see middleware.ts).
// Separate from PATCH .../status — Rejected is only ever reached through
// here, never as a plain status flip, because it needs to also send the
// leader a real explanatory message (unlike Settled/Ongoing/Pending, which
// only log a short system audit line). One insert for the visible staff
// message, one for the system audit line (so deriveStatusHistory() on the
// client picks it up the same way every other status change does), one
// update for the ticket itself.
const REJECT_MESSAGE = `Ticket Closed — Outside Scope
This concern is outside the scope of this system, which is intended for account-related issues and concerns only.

Please coordinate with your Team Leader and raise the concern through the Telegram TL window for further assistance.`;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApi(request);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const ticketId = Number((await params).id);
  if (!Number.isInteger(ticketId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getDb();
  const [ticket] = await db.select({ status: tickets.status, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  // OPS settles Agent concern; ACC settles Shop replacement + Adding new
  // account (see TICKET_SETTLE_PERMISSION in permissions.ts).
  if (!ticket || !canSettleTicket(session.permissions, ticket.title)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (ticket.status === 'settled' || ticket.status === 'rejected') {
    return NextResponse.json({ error: 'This ticket is already closed.' }, { status: 400 });
  }

  const [updated] = await db
    .update(tickets)
    .set({ status: 'rejected', updatedAt: new Date(), staffLastViewedAt: new Date() })
    .where(eq(tickets.id, ticketId))
    .returning();

  const [rejectMessage] = await db
    .insert(ticketMessages)
    .values({
      ticketId,
      senderId: session.userId,
      senderRole: 'staff',
      message: REJECT_MESSAGE,
    })
    .returning();

  const [logEntry] = await db
    .insert(ticketMessages)
    .values({
      ticketId,
      senderId: session.userId,
      senderRole: 'system',
      message: `Status changed to Rejected by ${session.username}.`,
    })
    .returning();

  return NextResponse.json({ ticket: updated, message: rejectMessage, statusLogMessage: logEntry }, { headers: { 'Cache-Control': 'no-store' } });
}
