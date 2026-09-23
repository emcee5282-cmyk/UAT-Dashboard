'use client';

// The leader's ticket history landing page — first thing they see after
// login. Standalone flow (bypasses AppShell/Sidebar, see AppShell.tsx's
// pathname bypass) — uses the dashboard's shared design tokens
// (app/globals.css: --background/--foreground/--border/--muted/
// --product-accent) so it inherits dark mode automatically, rather than
// the hardcoded light/purple palette this flow used before.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut, Plus, Search, Store, UserPlus, UserRound } from 'lucide-react';
import { useVisibilityPolling } from '@/app/lib/useVisibilityPolling';

// Longer than the detail thread's poll (new tickets/unread badges are
// lower-urgency than an open conversation) — still visibility-paused.
const POLL_INTERVAL_MS = 9000;

type TicketRow = {
  id: number;
  title: 'agent_concern' | 'shop_replacement' | 'adding_new_account';
  issueType: string | null;
  agentIds: number[] | null;
  shopIds: number[] | null;
  numShops: number | null;
  status: 'pending' | 'ongoing' | 'settled' | 'rejected';
  priority: 'urgent' | 'moderate' | 'normal';
  createdAt: string;
  // From the leader's own POV, "unread" already means "unread reply from
  // ops" (see app/api/tickets/route.ts's hasUnread computation: newest
  // message wasn't the leader's own and arrived after their lastViewedAt)
  // — no data-model change needed for that concept.
  hasUnread: boolean;
  lastMessageText: string | null;
  lastMessageSenderRole: 'leader' | 'staff' | 'system' | null;
};

// Same amber/blue/emerald convention the staff queue already uses
// (app/staff/tickets/QueueListPanel.tsx) — reused rather than inventing a
// new status palette, with dark: variants added since this flow now
// participates in the app's dark mode.
const STATUS_STYLE: Record<TicketRow['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  ongoing: { label: 'Ongoing', className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' },
  settled: { label: 'Settled', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' },
};

const TYPE_STYLE: Record<TicketRow['title'], { Icon: typeof Store; className: string }> = {
  shop_replacement: { Icon: Store, className: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' },
  agent_concern: { Icon: UserRound, className: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400' },
  adding_new_account: { Icon: UserPlus, className: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400' },
};

const FILTERS: { value: 'all' | TicketRow['status']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'settled', label: 'Settled' },
  { value: 'rejected', label: 'Rejected' },
];

function summarize(t: TicketRow): string {
  if (t.title === 'agent_concern') {
    const count = t.agentIds?.length ?? 0;
    return `Agent concern — ${t.issueType ?? 'Issue'}${count > 1 ? ` (${count} agents)` : ''}`;
  }
  if (t.title === 'shop_replacement') {
    const count = t.shopIds?.length ?? 0;
    return `Shop replacement — ${count} shop${count === 1 ? '' : 's'}`;
  }
  return `Adding new account — ${t.numShops ?? '?'} shop${t.numShops === 1 ? '' : 's'}`;
}

// Real last-message preview (same "You: " convention as staff's own queue
// list, just from the leader's side) — falls back to a static description
// only for the rare ticket with no replies yet.
function subtitleFor(t: TicketRow): string {
  if (t.lastMessageText) {
    return `${t.lastMessageSenderRole === 'leader' ? 'You: ' : ''}${t.lastMessageText}`;
  }
  if (t.title === 'agent_concern' && t.issueType) return t.issueType;
  return 'Submitted, awaiting review';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Settled tickets always sink to the bottom regardless of date; within the
// rest, an unread ops reply floats to the top; otherwise newest first.
function compareTickets(a: TicketRow, b: TicketRow): number {
  const aSettled = a.status === 'settled';
  const bSettled = b.status === 'settled';
  if (aSettled !== bSettled) return aSettled ? 1 : -1;
  if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export default function TicketsListPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | TicketRow['status']>('all');

  const loadTickets = useCallback(() => {
    return fetch('/api/tickets')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load tickets');
        return res.json();
      })
      .then((data) => {
        setTickets((prev) => {
          const next = (data.tickets ?? []) as TicketRow[];
          // Bail out to the same reference when the poll returned
          // identical data, so nothing downstream re-renders needlessly.
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
          return next;
        });
      })
      .catch(() => {
        setError('Could not load your tickets. Try refreshing the page.');
      });
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useVisibilityPolling(loadTickets, POLL_INTERVAL_MS);

  // Leaders never see the dashboard's AccountMenu (this whole flow bypasses
  // AppShell/Sidebar) — this is their only way to end the session.
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  const counts = useMemo(() => {
    const base = { all: tickets?.length ?? 0, pending: 0, ongoing: 0, settled: 0, rejected: 0 };
    for (const t of tickets ?? []) base[t.status]++;
    return base;
  }, [tickets]);

  const visibleTickets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (tickets ?? [])
      .filter((t) => {
        if (filter !== 'all' && t.status !== filter) return false;
        if (!query) return true;
        return summarize(t).toLowerCase().includes(query);
      })
      .sort(compareTickets);
  }, [tickets, filter, search]);

  return (
    <div className="min-h-screen w-full bg-background font-[Inter,sans-serif] text-foreground">
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-8">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Tickets</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/tickets/create')}
              aria-label="Create ticket"
              className="flex items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] sm:px-3.5"
            >
              <Plus size={15} />
              <span className="hidden sm:inline">Create ticket</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              aria-label="Log out"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] border border-border bg-card text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>

        <div className="relative mb-4">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor="ticket-search" className="sr-only">
            Search tickets
          </label>
          <input
            id="ticket-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tickets"
            className="w-full rounded-[12px] border border-border bg-card py-2.5 pl-10 pr-4 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
          />
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                filter === f.value
                  ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]'
                  : 'border border-border bg-card text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label} ({counts[f.value]})
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
            {error}
          </div>
        )}

        {tickets === null && !error && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {tickets !== null && tickets.length === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="text-[13.5px] font-bold">No tickets yet</p>
            <p className="mt-1 text-[12px] text-muted-foreground">Create a ticket to report an issue or request a change.</p>
          </div>
        )}

        {tickets !== null && tickets.length > 0 && visibleTickets.length === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="text-[13.5px] font-bold">No matching tickets</p>
            <p className="mt-1 text-[12px] text-muted-foreground">Try a different search term or filter.</p>
          </div>
        )}

        {visibleTickets.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card">
            {visibleTickets.map((t) => {
              const { Icon, className: iconClassName } = TYPE_STYLE[t.title];
              const statusStyle = STATUS_STYLE[t.status];
              const weightClassName = t.hasUnread ? 'font-bold' : 'font-normal';
              return (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => router.push(`/tickets/${t.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                >
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13.5px] leading-[1.3] ${weightClassName}`}>{summarize(t)}</span>
                    <span className={`mt-0.5 block truncate text-[12px] text-muted-foreground ${weightClassName}`}>{subtitleFor(t)}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="text-[11.5px] text-muted-foreground">{formatDate(t.createdAt)}</span>
                    {t.hasUnread ? (
                      <span className="h-2 w-2 rounded-full bg-[color:var(--ui-accent)]" aria-label="Unread" />
                    ) : (
                      <span className={`inline-flex items-center rounded-[6px] px-2 py-0.5 text-[10.5px] font-bold ${statusStyle.className}`}>
                        {statusStyle.label}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
