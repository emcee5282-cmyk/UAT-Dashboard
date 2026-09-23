import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { ticketMessages, tickets } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

const VALID_STATUSES = ['pending', 'ongoing', 'settled'] as const;
const STATUS_LABEL: Record<(typeof VALID_STATUSES)[number], string> = {
  pending: 'Pending',
  ongoing: 'Ongoing',
  settled: 'Settled',
};

// Staff/admin-only (admin now shares the staff queue, see middleware.ts).
// Logs the change as a 'system' ticket_messages row (visible to both sides
// in the same thread) rather than a separate history table — simplest
// option that still answers "who changed it, when."
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || (session.role !== 'staff' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ticketId = Number((await params).id);
  if (!Number.isInteger(ticketId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const status = (body.status ?? '') as (typeof VALID_STATUSES)[number];
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'A valid status is required.' }, { status: 400 });
  }

  const db = getDb();
  const [ticket] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (ticket.status === status) {
    return NextResponse.json({ error: 'Ticket is already in that status.' }, { status: 400 });
  }

  // Settled and Rejected are both terminal — once reached, staff can't
  // reopen back to Pending/Ongoing. Enforced here (not just by hiding the
  // buttons client-side) so a stale tab or a direct API call can't bypass
  // it. Rejected itself is only ever reached via POST .../reject (it needs
  // to send the templated message too, not just flip a status), not this
  // route — VALID_STATUSES above doesn't include it.
  if (ticket.status === 'settled' || ticket.status === 'rejected') {
    return NextResponse.json({ error: 'This ticket is closed and cannot be reopened.' }, { status: 400 });
  }

  const [updated] = await db
    .update(tickets)
    .set({ status, updatedAt: new Date(), staffLastViewedAt: new Date() })
    .where(eq(tickets.id, ticketId))
    .returning();

  // Moving to 'ongoing' is treated as staff claiming the ticket — logged
  // as a distinct 'assigned' kind (not a plain status-change line) because
  // its display text is role-sensitive: GET /api/tickets/:id redacts the
  // assignee's name entirely for leader callers. This response always goes
  // to a staff/admin caller (this route is staff/admin-only), so returning
  // the name-bearing text here is safe.
  const [logEntry] = await db
    .insert(ticketMessages)
    .values(
      status === 'ongoing'
        ? {
            ticketId,
            senderId: session.userId,
            senderRole: 'system',
            kind: 'assigned',
            message: `This ticket has been assigned to ${session.username}.`,
          }
        : {
            ticketId,
            senderId: session.userId,
            senderRole: 'system',
            message: `Status changed to ${STATUS_LABEL[status]} by ${session.username}.`,
          }
    )
    .returning();

  return NextResponse.json({ ticket: updated, message: logEntry }, { headers: { 'Cache-Control': 'no-store' } });
}
