'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Loader2, Search } from 'lucide-react';
import {
  buildAllUnreconciledViews,
  sortUnreconciledRows,
  sumUnreconciledRows,
  type UnreconciledAllViews,
  type UnreconciledLeaderRow,
  type UnreconciledSortKey,
  type UnreconciledView,
} from '@/app/lib/unreconciledBalanceAggregate';
import type { UnreconciledBalanceRow } from '@/app/lib/services/unreconciledBalanceService';
import { downloadUnreconciledBalanceExport } from '@/app/lib/unreconciledBalanceExport';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { consumeForceRefresh } from './forceRefresh';

// Same button-shell convention as DiscrepancySummaryTab's own Export button
// — duplicated locally for the same reason (not exported from its page,
// scoped to this tab only).
const EXPORT_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:pointer-events-none disabled:opacity-50 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
// Zero displays as "–", per spec — same convention as Discrepancy Summary.
function fmtOrDash(n: number): string {
  return Math.round(n) === 0 ? '–' : fmt(n);
}

const CARDS: { key: UnreconciledView; label: string }[] = [
  { key: 'cashout', label: 'Cashout' },
  { key: 'sendmoney', label: 'Send Money' },
  { key: 'group', label: 'Group Total' },
];

const COLUMNS: { key: UnreconciledSortKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'leader', label: 'Group Leader', align: 'left' },
  { key: 'companyBalance', label: 'Total Company Balance', align: 'right' },
  { key: 'balanceInside', label: 'Total Wallet Balance', align: 'right' },
  { key: 'agentWithdrawal', label: 'Total Discrepancy', align: 'right' },
  { key: 'sdp', label: 'Total SDP', align: 'right' },
  { key: 'sdpVsBalance', label: 'Withheld Balance', align: 'right' },
];

function SelectorTabsSkeleton() {
  return (
    <div className="flex items-center gap-8">
      {CARDS.map((c) => (
        <div key={c.key} className="dt-skeleton h-[13px] w-20 rounded" />
      ))}
    </div>
  );
}

function SelectorTabs({ selected, onSelect }: { selected: UnreconciledView; onSelect: (v: UnreconciledView) => void }) {
  return (
    <div className="flex items-center gap-8">
      {CARDS.map((c) => {
        const isSelected = selected === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onSelect(c.key)}
            className={`relative flex h-8 items-center text-[13.5px] transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:content-[''] ${
              isSelected
                ? 'font-semibold text-foreground after:bg-[#3b82f6]'
                : 'font-medium text-muted-foreground after:bg-transparent hover:text-foreground'
            }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function ExportButton({ views, exporting, onExport }: { views: UnreconciledAllViews | null; exporting: boolean; onExport: () => void }) {
  return (
    <button type="button" onClick={onExport} disabled={!views || exporting} aria-label="Export to Excel" title="Export" className={EXPORT_BUTTON}>
      {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      <span className="hidden xl:inline">Export</span>
    </button>
  );
}

function SearchBox({ value, onChange, loading }: { value: string; onChange: (v: string) => void; loading: boolean }) {
  return (
    <div className="flex h-8 w-[280px] shrink-0 items-center gap-[6px] rounded-full border border-[#E5E7EB] bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:border-[#262B38] dark:bg-[#12151D]">
      {loading ? (
        <div className="dt-skeleton h-[10px] w-32 rounded-md" />
      ) : (
        <>
          <Search size={13} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="flex-1 bg-transparent text-[11px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
            placeholder="Search leader"
          />
        </>
      )}
    </div>
  );
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown size={11} className="shrink-0 text-[#CBD5E1] dark:text-[#3A3F4D]" />;
  return direction === 'asc' ? <ArrowUp size={11} className="shrink-0 text-foreground" /> : <ArrowDown size={11} className="shrink-0 text-foreground" />;
}

export default function UnreconciledBalanceTab() {
  const [rawRows, setRawRows] = useState<UnreconciledBalanceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<UnreconciledView>('cashout');
  const [exporting, setExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<UnreconciledSortKey>('agentWithdrawal');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const force = consumeForceRefresh();
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/unreconciled-balance?t=${Date.now()}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (cancelled) return;
      setRawRows(json.rows ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Export always uses the full (unfiltered) data, same convention as
  // DiscrepancySummaryTab's own Export button.
  const views = rawRows ? buildAllUnreconciledViews(rawRows) : null;

  // Search filters by leader name only (no shop-level drill-down exists on
  // this tab), applied AFTER aggregation since each row already is a leader.
  const query = searchTerm.trim().toLowerCase();
  const activeLeaders = views ? views[selected] : null;
  const searchedLeaders = activeLeaders && query ? activeLeaders.filter((r) => r.leader.toLowerCase().includes(query)) : activeLeaders;
  const sortedLeaders = searchedLeaders ? sortUnreconciledRows(searchedLeaders, sortKey, sortDirection) : null;
  // Total row always reflects whatever is currently visible (search-filtered),
  // per spec.
  const visibleTotals = sortedLeaders ? sumUnreconciledRows(sortedLeaders) : null;

  function handleSort(key: UnreconciledSortKey) {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection(key === 'leader' ? 'asc' : 'desc');
    }
  }

  async function handleExport() {
    if (!views) return;
    setExporting(true);
    try {
      await downloadUnreconciledBalanceExport(views);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          {loading || !views ? <SelectorTabsSkeleton /> : <SelectorTabs selected={selected} onSelect={setSelected} />}
          <SearchBox value={searchTerm} onChange={setSearchTerm} loading={loading} />
        </div>
        <ExportButton views={views} exporting={exporting} onExport={handleExport} />
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-[#DEE1E8] dark:border-[#262B38]">
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col style={{ width: '22%' }} />
            <col style={{ width: '15.6%' }} />
            <col style={{ width: '15.6%' }} />
            <col style={{ width: '15.6%' }} />
            <col style={{ width: '15.6%' }} />
            <col style={{ width: '15.6%' }} />
          </colgroup>
          <thead>
            <tr className="h-[38px]">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119] ${
                    col.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSort(col.key)}
                    className={`inline-flex items-center gap-1 hover:text-foreground ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
                  >
                    {col.label}
                    <SortIcon active={sortKey === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          {!loading && sortedLeaders && (
            <tbody>
              {sortedLeaders.map((leader) => (
                <LeaderRow key={leader.leader} leader={leader} />
              ))}
            </tbody>
          )}
          {!loading && visibleTotals && (
            <tbody>
              <tr className="sticky bottom-0 z-[2] h-[38px] font-medium">
                <td className="border-t-2 border-[#CBD5E1] bg-white px-5 text-foreground dark:border-[#334155] dark:bg-[#12151D]">Total</td>
                <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                  {fmtOrDash(visibleTotals.companyBalance)}
                </td>
                <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                  {fmtOrDash(visibleTotals.balanceInside)}
                </td>
                <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums dark:border-[#334155] dark:bg-[#12151D]" style={{ color: 'var(--dd-neg)' }}>
                  {fmtOrDash(visibleTotals.agentWithdrawal)}
                </td>
                <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                  {fmtOrDash(visibleTotals.sdp)}
                </td>
                <td
                  className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums dark:border-[#334155] dark:bg-[#12151D]"
                  style={visibleTotals.sdpVsBalance < 0 ? { color: 'var(--dd-neg)' } : undefined}
                >
                  {fmtOrDash(visibleTotals.sdpVsBalance)}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

function LeaderRow({ leader }: { leader: UnreconciledLeaderRow }) {
  return (
    <tr className="dt-row-stagger-in border-b border-[#ECEFF3] dark:border-[#1A1E29]">
      <td className="overflow-hidden px-5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{leader.leader}</span>
          <span className="shrink-0 text-muted-foreground">({leader.shopCount})</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground">{fmtOrDash(leader.companyBalance)}</td>
      <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground">{fmtOrDash(leader.balanceInside)}</td>
      <td className="whitespace-nowrap px-5 py-2 text-right font-medium tabular-nums" style={{ color: 'var(--dd-neg)' }}>
        {fmtOrDash(leader.agentWithdrawal)}
      </td>
      <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground">{fmtOrDash(leader.sdp)}</td>
      <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums" style={leader.sdpVsBalance < 0 ? { color: 'var(--dd-neg)' } : { color: 'var(--foreground)' }}>
        {fmtOrDash(leader.sdpVsBalance)}
      </td>
    </tr>
  );
}
