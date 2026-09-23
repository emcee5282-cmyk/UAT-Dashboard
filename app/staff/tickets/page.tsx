'use client';

// The staff ticket queue — a full-width table (Design System v2 table
// conventions, see CLAUDE.md), replacing the old persistent side-panel
// card list. Selecting a row navigates to /staff/tickets/[id] (a sibling
// route under the same layout, see layout.tsx) — no separate "select a
// ticket" placeholder state anymore, this table IS the entry point.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Moon, RefreshCw, Search, Sun } from 'lucide-react';
import { useVisibilityPolling } from '@/app/lib/useVisibilityPolling';
import { useTheme } from '@/app/components/ThemeProvider';
import AccountMenu from '@/app/components/AccountMenu';

const POLL_INTERVAL_MS = 9000;

type TicketType = 'agent_concern' | 'shop_replacement' | 'adding_new_account';

type StaffTicketRow = {
  id: number;
  title: TicketType;
  issueType: string | null;
  agentIds: number[] | null;
  shopIds: number[] | null;
  numShops: number | null;
  status: 'pending' | 'ongoing' | 'settled' | 'rejected';
  priority: 'urgent' | 'moderate' | 'normal';
  createdAt: string;
  leaderName: string | null;
};

const TYPE_META: Record<TicketType, { label: string; dotClassName: string }> = {
  agent_concern: { label: 'Agent concern', dotClassName: 'bg-indigo-500' },
  shop_replacement: { label: 'Shop replacement', dotClassName: 'bg-amber-500' },
  adding_new_account: { label: 'Adding new account', dotClassName: 'bg-purple-500' },
};

const STATUS_STYLE: Record<StaffTicketRow['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  ongoing: { label: 'Ongoing', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  settled: { label: 'Settled', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const PRIORITY_STYLE: Record<StaffTicketRow['priority'], { label: string; className: string }> = {
  urgent: { label: 'Urgent', className: 'text-rose-600 font-bold' },
  moderate: { label: 'Moderate', className: 'text-amber-600' },
  normal: { label: 'Normal', className: 'text-muted-foreground' },
};

// Tagging is derived from ticket type, never stored — two colors not
// already used for status (amber/blue/emerald) or priority (rose), so the
// column stays visually distinct.
type Tag = 'OPS' | 'ACC';
const TAG_META: Record<Tag, { label: string; className: string }> = {
  OPS: { label: 'Operations Team', className: 'bg-violet-50 text-violet-700 border-violet-200' },
  ACC: { label: 'Account Team', className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
};
function getTag(t: StaffTicketRow): Tag {
  return t.title === 'agent_concern' ? 'OPS' : 'ACC';
}

type FilterValue = 'all' | 'urgent' | StaffTicketRow['status'];
const STATUS_FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'settled', label: 'Settled' },
  { value: 'rejected', label: 'Rejected' },
];

function summarize(t: StaffTicketRow): string {
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StaffTicketsIndexPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [tickets, setTickets] = useState<StaffTicketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>('all');

  const load = useCallback(() => {
    return fetch('/api/tickets')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load tickets');
        return res.json();
      })
      .then((data) => {
        setTickets((prev) => {
          const next = (data.tickets ?? []) as StaffTicketRow[];
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
          return next;
        });
      })
      .catch(() => setError('Could not load the ticket queue. Try refreshing the page.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useVisibilityPolling(load, POLL_INTERVAL_MS);

  const rows = useMemo(() => {
    if (!tickets) return [];
    let filtered = filter === 'all' ? tickets : filter === 'urgent' ? tickets.filter((t) => t.priority === 'urgent') : tickets.filter((t) => t.status === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((t) => (t.leaderName ?? '').toLowerCase().includes(q) || summarize(t).toLowerCase().includes(q) || `TCK-${t.id}`.toLowerCase().includes(q));
    }
    // Urgent always floats to the top, newest first otherwise (API's own
    // default order is preserved within each priority group).
    return [...filtered].sort((a, b) => (a.priority === 'urgent' ? -1 : 0) - (b.priority === 'urgent' ? -1 : 0));
  }, [tickets, filter, search]);

  return (
    // PageHeader's containerless variant paints its sticky bar using
    // var(--ink-0)/var(--hair), tokens only ever defined by app/page.tsx's
    // own scoped .dd-page stylesheet (its sole other consumer) — undefined
    // here otherwise, which would leave the bar transparent with no border.
    // Mapped locally to this app's real global tokens instead of touching
    // PageHeader.tsx or app/page.tsx's own styling.
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8"
      style={{ '--ink-0': 'var(--background)', '--hair': 'var(--border)' } as React.CSSProperties}
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col overflow-hidden">
        {/* Hand-built rather than the shared PageHeader — this pass needs a
            title size bigger than PageHeader's fixed 22px (see mockup), and
            PageHeader's own styling can't be touched (shared with Operations
            Overview). Matches [id]/page.tsx's own header, which is
            hand-built for the same reason (its own composability needs). */}
        <div
          className="sticky top-0 z-20 mb-[22px] flex flex-col items-start gap-2 border-b pb-[14px] pt-14 md:flex-row md:items-end md:justify-between md:pt-[14px]"
          style={{ background: 'var(--ink-0)', borderColor: 'var(--hair)' }}
        >
          <h1 className="truncate text-[20px] font-bold leading-tight text-foreground">Tickets</h1>
          <div className="flex w-full shrink-0 items-center justify-end gap-3 md:w-auto">
            <button
              type="button"
              onClick={() => load()}
              aria-label="Refresh"
              title="Refresh"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-foreground hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)]"
            >
              <RefreshCw size={11} />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle light and dark mode"
              title="Toggle light and dark mode"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-foreground hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)]"
            >
              {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
            </button>
            <AccountMenu compact />
          </div>
        </div>

        <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leader or ticket"
              className="w-full rounded-lg border border-border bg-white py-2 pl-9 pr-3 text-[12.5px] text-foreground placeholder:text-muted-foreground/70 focus:border-foreground focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilter('urgent')}
            className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${
              filter === 'urgent' ? 'border-rose-600 bg-rose-600 text-white' : 'border-rose-300 bg-white text-rose-600'
            }`}
          >
            Urgent
          </button>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold ${
                filter === f.value ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-border bg-white text-muted-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-700">{error}</div>
        )}

        {tickets === null && !error && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {tickets !== null && (
          <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-white">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 border-b border-border bg-muted/10">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Ticket</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Type</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Leader</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Tagging</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Submitted</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Priority</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-xs text-muted-foreground">
                      No tickets match this filter.
                    </td>
                  </tr>
                )}
                {rows.map((t) => {
                  const tm = TYPE_META[t.title];
                  const sm = STATUS_STYLE[t.status];
                  const pm = PRIORITY_STYLE[t.priority];
                  const tag = TAG_META[getTag(t)];
                  return (
                    <tr
                      key={t.id}
                      onClick={() => router.push(`/staff/tickets/${t.id}`)}
                      className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/10"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px] font-medium text-foreground">TCK-{t.id}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-foreground">
                        <span className="inline-flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tm.dotClassName}`} aria-hidden />
                          {tm.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px] font-semibold text-foreground">{t.leaderName ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px]">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${tag.className}`}>{tag.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-muted-foreground">{formatDate(t.createdAt)}</td>
                      <td className={`whitespace-nowrap px-4 py-3 text-[12.5px] ${pm.className}`}>{pm.label}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px]">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${sm.className}`}>{sm.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
