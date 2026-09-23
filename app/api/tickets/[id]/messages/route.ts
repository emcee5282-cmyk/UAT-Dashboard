import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { ticketMessages, tickets } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';

// Leaders can only post to their own ticket; staff/admin can post to any
// ticket (cross-leader queue, see /staff/tickets — admin now shares the
// staff queue, see middleware.ts). senderRole always matches the caller's
// own session role — never client-supplied. Admin posts are recorded as
// 'staff' (no separate 'admin' value in ticketMessageSenderRoleEnum —
// admin is treated as staff-equivalent for this feature's data model).
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
  const [ticket] = await db.select({ createdBy: tickets.createdBy, status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket || (!isStaff && ticket.createdBy !== session.userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // A settled/rejected ticket's composer is closed client-side, but that's
  // UI-only — enforce it here too so a stale tab (or a direct API call)
  // can't post into a conversation that's already locked (see PATCH
  // .../status's own matching guard).
  if (ticket.status === 'settled' || ticket.status === 'rejected') {
    return NextResponse.json({ error: 'This ticket is closed — the conversation is no longer open.' }, { status: 400 });
  }

  let body: { message?: string; attachmentData?: string; attachmentMimeType?: string; attachmentName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const message = (body.message ?? '').toString().trim();

  // Image-only attachments (Photo/Camera picker) — stored inline as base64,
  // no object storage configured for this project. Documents from the same
  // picker are intentionally not accepted here; no viewer exists for them
  // yet (composer-preview-only, per the redesign's flagged backend gap).
  let attachmentData: string | null = null;
  let attachmentMimeType: string | null = null;
  let attachmentName: string | null = null;
  if (body.attachmentData) {
    const mimeType = (body.attachmentMimeType ?? '').toString();
    if (!mimeType.startsWith('image/')) {
      return NextResponse.json({ error: 'Only image attachments are supported.' }, { status: 400 });
    }
    // ~5MB raw file cap, checked against the inflated base64 length
    // (base64 runs ~4/3 the size of the original bytes).
    if (body.attachmentData.length > 5 * 1024 * 1024 * 1.34) {
      return NextResponse.json({ error: 'Image is too large (max 5MB).' }, { status: 400 });
    }
    attachmentData = body.attachmentData;
    attachmentMimeType = mimeType;
    attachmentName = (body.attachmentName ?? 'image').toString().slice(0, 255);
  }

  if (!message && !attachmentData) {
    return NextResponse.json({ error: 'Message cannot be empty.' }, { status: 400 });
  }

  const [created] = await db
    .insert(ticketMessages)
    .values({
      ticketId,
      senderId: session.userId,
      senderRole: isStaff ? 'staff' : 'leader',
      message,
      attachmentData,
      attachmentMimeType,
      attachmentName,
    })
    .returning();

  // Posting counts as viewing — no unread flag for a message this side just
  // sent themselves.
  await db
    .update(tickets)
    .set(isStaff ? { staffLastViewedAt: new Date() } : { lastViewedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  // A staff reply on a still-Pending ticket counts as staff picking it up —
  // same auto-claim semantics as manually hitting "Mark Ongoing" (PATCH
  // .../status), reusing its exact 'assigned' log convention so
  // deriveStatusHistory() on the client renders it identically either way.
  let statusLogMessage: typeof created | null = null;
  if (isStaff && ticket.status === 'pending') {
    await db.update(tickets).set({ status: 'ongoing', updatedAt: new Date() }).where(eq(tickets.id, ticketId));
    [statusLogMessage] = await db
      .insert(ticketMessages)
      .values({
        ticketId,
        senderId: session.userId,
        senderRole: 'system',
        kind: 'assigned',
        message: `This ticket has been assigned to ${session.username}.`,
      })
      .returning();
  }

  return NextResponse.json(
    { message: created, statusLogMessage, autoStatus: statusLogMessage ? 'ongoing' : null },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
