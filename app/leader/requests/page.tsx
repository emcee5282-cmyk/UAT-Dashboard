'use client';

// Leader app → My Requests: everything this leader submitted (tickets and
// top-up/settlement requests) with a simple status: Pending (pending +
// ongoing), Approved (settled), Rejected. Tapping one opens the existing
// ticket thread (/tickets/[id]), whose chat/reply behavior is unchanged.
// Source is the existing GET /api/tickets (own tickets only for leaders).
// Fetch on open + manual Refresh only.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import LeaderBottomNav, { LEADER_NAV_PADDING } from '@/app/components/LeaderBottomNav';
import { LEADER_STATUS_STYLE, REQUEST_LABEL, formatAmount, isRequestTitle, leaderStatus, type LeaderStatus } from '@/app/lib/leaderRequests';

type TicketRow = {
  id: number;
  title: string;
  issueType: string | null;
  agentIds: number[] | null;
  shopIds: number[] | null;
  numShops: number | null;
  requestAmount: string | null;
  requestWallet: string | null;
  requestShopCode: string | null;
  status: string;
  createdAt: string;
  hasUnread: boolean;
};

const TICKET_LABEL: Record<string, string> = {
  agent_concern: 'Agent concern',
  shop_replacement: 'Shop replacement',
  adding_new_account: 'Adding new account',
};

const STATUS_FILTERS: { value: 'all' | LeaderStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];
const KIND_FILTERS = [
  { value: 'all', label: 'Everything' },
  { value: 'requests', label: 'Requests' },
  { value: 'tickets', label: 'Tickets' },
] as const;

function titleFor(t: TicketRow): string {
  if (isRequestTitle(t.title)) return REQUEST_LABEL[t.title];
  return TICKET_LABEL[t.title] ?? 'Ticket';
}

function detailFor(t: TicketRow): string {
  if (isRequestTitle(t.title)) return `${t.requestShopCode ?? 'Shop'} · ${t.requestWallet ?? ''} · ${formatAmount(t.requestAmount)}`;
  if (t.title === 'agent_concern') return t.issueType ?? 'Issue';
  if (t.title === 'shop_replacement') return `${t.shopIds?.length ?? 0} shop(s)`;
  return `${t.numShops ?? '?'} shop(s)`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// useSearchParams needs a Suspense boundary in the App Router.
export default function LeaderRequestsPage() {
  return (
    <Suspense>
      <LeaderRequestsContent />
    </Suspense>
  );
}

function LeaderRequestsContent() {
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'all' | LeaderStatus>('all');
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]['value']>('all');
  const justSent = useSearchParams().get('sent') === '1';

  const fetchTickets = useCallback(
    () =>
      fetch('/api/tickets', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((d) => { setTickets(d.tickets ?? []); setError(null); })
        .catch(() => setError('Could not load your requests. Check your connection and tap Refresh.')),
    []
  );

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  function load() {
    setLoading(true);
    fetchTickets().finally(() => setLoading(false));
  }

  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, approved: 0, rejected: 0 };
    for (const t of tickets ?? []) {
      if (kind === 'requests' && !isRequestTitle(t.title)) continue;
      if (kind === 'tickets' && isRequestTitle(t.title)) continue;
      c.all++;
      c[leaderStatus(t.status)]++;
    }
    return c;
  }, [tickets, kind]);

  const visible = useMemo(
    () =>
      (tickets ?? [])
        .filter((t) => (kind === 'all' ? true : kind === 'requests' ? isRequestTitle(t.title) : !isRequestTitle(t.title)))
        .filter((t) => status === 'all' || leaderStatus(t.status) === status)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tickets, status, kind]
  );

  return (
    <div className="h-dvh w-full overflow-y-auto bg-background font-[Inter,sans-serif] text-foreground">
      <div className={`mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 ${LEADER_NAV_PADDING}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">My Requests</h1>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh"
            className="flex h-11 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {justSent && (
          <div role="status" className="mb-4 flex items-center gap-2 rounded-[9px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
            <CheckCircle2 size={16} /> Request sent. It shows as Pending until it&apos;s reviewed.
          </div>
        )}

        <div className="mb-3 grid grid-cols-3 gap-1 rounded-[12px] border border-border bg-card p-1">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setKind(f.value)}
              aria-pressed={kind === f.value}
              className={`h-10 rounded-[9px] text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                kind === f.value ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
              aria-pressed={status === f.value}
              className={`h-10 rounded-full px-4 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                status === f.value ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'border border-border bg-card text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label} ({counts[f.value]})
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">{error}</div>
        )}

        {tickets === null && !error && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {tickets !== null && visible.length === 0 && (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="text-[13.5px] font-bold">Nothing here yet</p>
            <p className="mt-1 text-[12px] text-muted-foreground">Requests and tickets you send show here with their status.</p>
          </div>
        )}

        {visible.length > 0 && (
          <ul className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card">
            {visible.map((t) => {
              const s = LEADER_STATUS_STYLE[leaderStatus(t.status)];
              return (
                <li key={t.id}>
                  <Link
                    href={`/tickets/${t.id}`}
                    className="flex min-h-[72px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[14.5px] font-semibold">{titleFor(t)}</span>
                        {t.hasUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--ui-accent)]" aria-label="New reply" />}
                      </span>
                      <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{detailFor(t)}</span>
                      <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{formatDate(t.createdAt)}</span>
                    </span>
                    <span className={`inline-flex shrink-0 items-center rounded-[6px] px-2.5 py-1 text-[11.5px] font-bold ${s.className}`}>{s.label}</span>
                    <ChevronRight size={18} className="shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <LeaderBottomNav />
    </div>
  );
}
