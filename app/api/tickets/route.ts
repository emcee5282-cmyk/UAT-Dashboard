import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { agents, leaders, ticketMessages, tickets, users } from '@/app/lib/db/schema';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/app/lib/auth/session';
import { classifyTicketPriority } from '@/app/lib/ticketPriorityClassifier';

const PRIORITY_RANK = { urgent: 0, moderate: 1, normal: 2 } as const;

const VALID_STATUSES = ['pending', 'ongoing', 'settled', 'rejected'];

type CreateTicketBody = {
  title?: string;
  issueType?: string;
  agentIds?: number[];
  shopIds?: number[];
  dailyLimit?: string | number;
  limitDuration?: string;
  numShops?: string | number;
  details?: string;
};

const VALID_TITLES = ['agent_concern', 'shop_replacement', 'adding_new_account'];
const VALID_DURATIONS = ['day_shift', '24_hours'];

// Confirms every id actually belongs to this leader's own agent pool before
// it can land in a ticket — agentIds/shopIds are plain integer[] columns
// with no real FK constraint possible on an array, so this app-layer check
// is the only thing standing between a leader and referencing someone
// else's agents.
async function idsBelongToLeader(ids: number[], leaderId: number): Promise<boolean> {
  if (ids.length === 0) return true;
  const db = getDb();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, ids), eq(agents.leaderId, leaderId)));
  return rows.length === ids.length;
}

// Leader's own ticket history (scoped to the logged-in user, not the
// broader leader entity — matches how ownership is checked everywhere else
// here, createdBy = session.userId) — OR staff/admin's cross-leader queue,
// branched by role (admin now shares the staff queue view — see
// middleware.ts's STAFF_OR_ADMIN_ONLY_PATH_PREFIXES). Query params
// (staff/admin only): ?status=pending|ongoing|settled to filter,
// ?sort=unread to surface unread-from-leader tickets first.
export async function GET(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || (session.role !== 'leader' && session.role !== 'staff' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const isStaffQueue = session.role === 'staff' || session.role === 'admin';

  let rows: (typeof tickets.$inferSelect & { leaderName?: string | null; submittedByUsername?: string | null })[];
  if (isStaffQueue) {
    const statusFilter = request.nextUrl.searchParams.get('status');
    const whereClause = statusFilter && VALID_STATUSES.includes(statusFilter) ? eq(tickets.status, statusFilter as 'pending' | 'ongoing' | 'settled' | 'rejected') : undefined;
    const joined = await db
      .select({ ticket: tickets, leaderName: leaders.name, submittedByUsername: users.username })
      .from(tickets)
      .leftJoin(users, eq(tickets.createdBy, users.id))
      .leftJoin(leaders, eq(users.leaderId, leaders.id))
      .where(whereClause)
      .orderBy(desc(tickets.createdAt));
    rows = joined.map((r) => ({ ...r.ticket, leaderName: r.leaderName, submittedByUsername: r.submittedByUsername }));
  } else {
    rows = await db.select().from(tickets).where(eq(tickets.createdBy, session.userId)).orderBy(desc(tickets.createdAt));
  }

  const ticketIds = rows.map((t) => t.id);
  // Latest message per ticket, computed in JS from an ascending-ordered
  // fetch (last write wins) rather than a DISTINCT ON query — ticket counts
  // are small enough per query that this is simpler than raw SQL here.
  const latestByTicket = new Map<number, { senderRole: string; createdAt: Date; message: string; kind: string | null }>();
  if (ticketIds.length > 0) {
    const messages = await db
      .select({
        ticketId: ticketMessages.ticketId,
        senderRole: ticketMessages.senderRole,
        createdAt: ticketMessages.createdAt,
        message: ticketMessages.message,
        kind: ticketMessages.kind,
      })
      .from(ticketMessages)
      .where(inArray(ticketMessages.ticketId, ticketIds))
      .orderBy(ticketMessages.createdAt);
    for (const m of messages) {
      latestByTicket.set(m.ticketId, { senderRole: m.senderRole, createdAt: m.createdAt, message: m.message, kind: m.kind });
    }
  }

  let result = rows.map((t) => {
    const latest = latestByTicket.get(t.id);
    // Leader view: unread if the newest message wasn't the leader's own and
    // arrived after their last view. Staff view: the mirror image — unread
    // (from-leader) if the newest message IS from a leader and arrived
    // after any staff member last looked (see staffLastViewedAt comment in
    // schema.ts — no per-staff-member read tracking in this phase).
    const hasUnread = isStaffQueue
      ? Boolean(latest && latest.senderRole === 'leader' && (!t.staffLastViewedAt || latest.createdAt > t.staffLastViewedAt))
      : Boolean(latest && latest.senderRole !== 'leader' && (!t.lastViewedAt || latest.createdAt > t.lastViewedAt));
    // Same redaction rule as GET /api/tickets/:id — a leader must never see
    // who claimed their ticket, including in this list-row snippet.
    const lastMessageText = latest ? (!isStaffQueue && latest.kind === 'assigned' ? 'This ticket has been assigned.' : latest.message) : null;
    return { ...t, hasUnread, lastMessageAt: latest?.createdAt ?? null, lastMessageText, lastMessageSenderRole: latest?.senderRole ?? null };
  });

  if (isStaffQueue) {
    const sortParam = request.nextUrl.searchParams.get('sort');
    if (sortParam === 'unread') {
      result = [...result].sort((a, b) => {
        if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    } else {
      // Default queue order: urgent, then moderate, then normal; newest
      // first within each priority group.
      result = [...result].sort((a, b) => {
        const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }
  }

  return NextResponse.json({ tickets: result }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session || session.role !== 'leader' || !session.leaderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CreateTicketBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const title = body.title ?? '';
  if (!VALID_TITLES.includes(title)) {
    return NextResponse.json({ error: 'A valid ticket title is required.' }, { status: 400 });
  }

  const details = (body.details ?? '').toString().trim().slice(0, 500) || null;

  if (title === 'agent_concern') {
    const issueType = (body.issueType ?? '').toString().trim();
    const agentIds = Array.isArray(body.agentIds) ? body.agentIds.filter((n) => Number.isInteger(n)) : [];
    if (!issueType) {
      return NextResponse.json({ error: 'Issue type is required.' }, { status: 400 });
    }
    if (agentIds.length === 0) {
      return NextResponse.json({ error: 'At least one agent ID is required.' }, { status: 400 });
    }
    if (!(await idsBelongToLeader(agentIds, session.leaderId))) {
      return NextResponse.json({ error: 'One or more agent IDs are not in your roster.' }, { status: 403 });
    }

    const db = getDb();
    const priority = classifyTicketPriority(issueType, details);
    const [created] = await db
      .insert(tickets)
      .values({ title, issueType, agentIds, details, priority, prioritySource: 'rule', createdBy: session.userId })
      .returning();
    return NextResponse.json({ ticket: created }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (title === 'shop_replacement') {
    const shopIds = Array.isArray(body.shopIds) ? body.shopIds.filter((n) => Number.isInteger(n)) : [];
    if (shopIds.length === 0) {
      return NextResponse.json({ error: 'At least one shop is required.' }, { status: 400 });
    }
    if (!(await idsBelongToLeader(shopIds, session.leaderId))) {
      return NextResponse.json({ error: 'One or more shops are not in your roster.' }, { status: 403 });
    }

    const db = getDb();
    const priority = classifyTicketPriority(null, details);
    const [created] = await db
      .insert(tickets)
      .values({ title, shopIds, details, priority, prioritySource: 'rule', createdBy: session.userId })
      .returning();
    return NextResponse.json({ ticket: created }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // adding_new_account
  const dailyLimit = (body.dailyLimit ?? '').toString().trim();
  const limitDuration = (body.limitDuration ?? '').toString().trim();
  const numShopsRaw = (body.numShops ?? '').toString().trim();
  const numShops = Number(numShopsRaw);

  if (!dailyLimit || Number.isNaN(Number(dailyLimit))) {
    return NextResponse.json({ error: 'A valid daily limit is required.' }, { status: 400 });
  }
  if (!VALID_DURATIONS.includes(limitDuration)) {
    return NextResponse.json({ error: 'A valid limit duration is required.' }, { status: 400 });
  }
  if (!numShopsRaw || !Number.isInteger(numShops) || numShops <= 0) {
    return NextResponse.json({ error: 'A valid number of shops is required.' }, { status: 400 });
  }

  const db = getDb();
  const priority = classifyTicketPriority(null, details);
  const [created] = await db
    .insert(tickets)
    .values({
      title: title as 'adding_new_account',
      dailyLimit,
      limitDuration: limitDuration as 'day_shift' | '24_hours',
      numShops,
      details,
      priority,
      prioritySource: 'rule',
      createdBy: session.userId,
    })
    .returning();
  return NextResponse.json({ ticket: created }, { headers: { 'Cache-Control': 'no-store' } });
}
