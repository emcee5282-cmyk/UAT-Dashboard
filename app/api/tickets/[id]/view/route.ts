import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { tickets } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

// Explicit "I actually looked at this" signal, decoupled from GET
// /api/tickets/:id (which is read-only — see that route's own comment).
// The client calls this only when the person clicks into the reply
// textbox or clicks the message thread itself — never on page load, never
// from a poll tick, never on scroll. Same ownership rule as GET: leaders
// scoped to their own ticket, staff/admin can view any.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const [ticket] = await db.select({ createdBy: tickets.createdBy }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket || (!isStaff && ticket.createdBy !== session.userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await db
    .update(tickets)
    .set(isStaff ? { staffLastViewedAt: new Date() } : { lastViewedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
