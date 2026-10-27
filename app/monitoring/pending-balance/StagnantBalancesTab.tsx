'use client';

// "Stagnant Balances" — Pending Balance's 3rd tab. Same shell as
// DiscrepancySummaryTab.tsx (accordion per leader, sticky expanded-leader
// row, scroll-release sentinel) — see that file's own comments for why the
// sticky-release mechanism works the way it does. Columns: Leader/Shop
// Name, Company Balance, Balance Inside, SDP, Settlement (today only),
// Shops/Days — no Agent Withdrawal column here. Shops within an expanded leader sort by streak
// length, never by any balance figure.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, ChevronDown, Download, Loader2, Search } from 'lucide-react';
import styles from './discrepancySummary.module.css';
import { buildAllStagnantViews, type StagnantAllViews, type StagnantLeaderGroup, type StagnantView, type StagnantBuckets } from '@/app/lib/stagnantBalanceAggregate';
import type { StagnantBalanceRow, StagnantRecoveredEntry } from '@/app/lib/services/stagnantBalanceService';
import { downloadStagnantBalanceExport } from '@/app/lib/stagnantBalanceExport';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { consumeForceRefresh } from './forceRefresh';

// Same icon/label/button-shell convention as DiscrepancySummaryTab's own
// Export button — duplicated locally per that file's own established
// reasoning (not exported from its page, scoped to this tab only).
const EXPORT_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:pointer-events-none disabled:opacity-50 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtOrDash(n: number): string {
  return Math.round(n) === 0 ? '–' : fmt(n);
}

// Company Balance: bold always, rose when negative, neutral bold otherwise
// — same convention as Agent Balance/Discrepancy Summary's own Company
// Balance column.
function companyBalanceStyle(n: number): CSSProperties {
  return n < 0 ? { color: 'var(--dd-neg)' } : {};
}

// Settlement column color (orange) — app-wide convention, only when there
// is actually a figure to show.
function settlementClass(n: number): string {
  return Math.round(n) === 0 ? 'text-muted-foreground' : 'text-orange-600 dark:text-orange-400';
}

const CARDS: { key: StagnantView; label: string }[] = [
  { key: 'cashout', label: 'Cashout' },
  { key: 'sendmoney', label: 'Send Money' },
  { key: 'group', label: 'Group Total' },
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

function SelectorTabs({ selected, onSelect }: { selected: StagnantView; onSelect: (v: StagnantView) => void }) {
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
            placeholder="Search for anything"
          />
        </>
      )}
    </div>
  );
}

// Same per-view accent colors as the Telegram image template (steel blue/
// teal/navy) — ties this summary band to the rest of the feature instead
// of inventing a 4th color scheme, but laid out compactly as one slim
// banner (title strip + a single row of figures) rather than the brown/
// orange Excel pivot's own look this was modeled after.
const VIEW_COLOR: Record<StagnantView, string> = {
  cashout: '#2f5d9a',
  sendmoney: '#0f766e',
  group: '#13285a',
};
const VIEW_LABEL: Record<StagnantView, string> = {
  cashout: 'Cashout',
  sendmoney: 'Send Money',
  group: 'Group Total',
};

function ExportButton({ views, exporting, onExport }: { views: StagnantAllViews | null; exporting: boolean; onExport: () => void }) {
  return (
    <button type="button" onClick={onExport} disabled={!views || exporting} aria-label="Export to Excel" title="Export" className={EXPORT_BUTTON}>
      {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      <span className="hidden xl:inline">Export</span>
    </button>
  );
}

function SummaryBandSkeleton() {
  return <div className="dt-skeleton h-[72px] w-full rounded-[10px]" />;
}

// Formats an ISO 'YYYY-MM-DD' date as "Oct 16, 2026" — no timezone
// conversion needed/wanted here, this is just the file's own stored date
// string, not a UTC instant.
function formatFileDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SummaryBand({ view, buckets, cashoutDaysAsOf }: { view: StagnantView; buckets: StagnantBuckets; cashoutDaysAsOf: string | null }) {
  const cells: { label: string; value: number }[] = [
    { label: '3 Days Above', value: buckets.threeDaysAbove },
    { label: '6 Days Above', value: buckets.sixDaysAbove },
    { label: '10 Days Above', value: buckets.tenDaysAbove },
    { label: '15 Days Above', value: buckets.fifteenDaysAbove },
    { label: 'Total', value: buckets.total },
    { label: 'Recovered', value: buckets.recovered },
  ];

  return (
    <div className="shrink-0 overflow-hidden rounded-[10px] border border-[#DEE1E8] dark:border-[#262B38]">
      <div className="flex items-center justify-between px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-white" style={{ background: VIEW_COLOR[view] }}>
        <span>{VIEW_LABEL[view]} &middot; Company Balance by Days Stagnant</span>
        {cashoutDaysAsOf && (
          <span className="font-normal normal-case tracking-normal text-white/80">Cashout days as of {formatFileDate(cashoutDaysAsOf)}</span>
        )}
      </div>
      <div className="grid grid-cols-6 divide-x divide-[#ECEFF3] bg-white dark:divide-[#1A1E29] dark:bg-[#12151D]">
        {cells.map((c) => (
          <div
            key={c.label}
            className={`px-3 py-2.5 text-center ${c.label === 'Total' ? 'bg-[#FAFBFC] dark:bg-[#0E1119]' : ''}`}
            title={c.label === 'Recovered' ? 'Settlement this month from every shop, counted from the day it was posted here' : undefined}
          >
            <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div
              className={`mt-0.5 text-[13px] tabular-nums ${c.label === 'Total' ? 'font-bold' : 'font-semibold'} ${c.label === 'Recovered' && Math.round(c.value) !== 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}
            >
              {fmtOrDash(c.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinePill({ line }: { line: 'cashout' | 'sendmoney' }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold ${line === 'cashout' ? styles.linePillCashout : styles.linePillSendMoney}`}>
      {line === 'cashout' ? 'Cashout' : 'Send Money'}
    </span>
  );
}

function LeaderRows({
  view,
  leader,
  isExpanded,
  onToggle,
  rowIndex,
}: {
  view: StagnantView;
  leader: StagnantLeaderGroup;
  isExpanded: boolean;
  onToggle: () => void;
  rowIndex: number;
}) {
  const showLine = view === 'group';

  // Same scroll-driven sticky-release mechanism as DiscrepancySummaryTab's
  // own LeaderRows — see that file's header comment for the full reasoning
  // (a 0-height sentinel row scrolled past the sticky offset drops
  // stickiness, recomputed on every scroll event rather than via
  // IntersectionObserver).
  const [pastOwnShops, setPastOwnShops] = useState(false);
  const sentinelRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (!isExpanded) {
      setPastOwnShops(false);
      return;
    }
    const sentinel = sentinelRef.current;
    const scrollContainer = sentinel?.closest('.overflow-auto') as HTMLElement | null;
    if (!sentinel || !scrollContainer) return;

    function recompute() {
      if (!sentinel || !scrollContainer) return;
      setPastOwnShops(sentinel.getBoundingClientRect().top < scrollContainer.getBoundingClientRect().top + 39);
    }
    recompute();
    scrollContainer.addEventListener('scroll', recompute, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', recompute);
  }, [isExpanded]);

  const stickyCell = isExpanded && !pastOwnShops ? 'sticky top-[38px] z-[1] bg-[#EEF4FF] dark:bg-[#151A28]' : '';

  return (
    <tbody>
      <tr
        className={`dt-row-stagger-in border-b border-[#ECEFF3] dark:border-[#1A1E29] ${styles.leaderRow} ${isExpanded ? `${styles.leaderRowExpanded} ${styles.stickyLeaderRow}` : ''}`}
        style={{ '--stagger-delay': `${Math.min(rowIndex, 12) * 30}ms` } as CSSProperties}
        onClick={onToggle}
      >
        {showLine && <td className={`px-5 py-2 ${stickyCell}`} />}
        <td className={`overflow-hidden px-5 py-2 ${stickyCell}`}>
          <div className="flex items-center gap-1.5">
            {isExpanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
            <span className="truncate font-medium text-foreground">{leader.leader}</span>
          </div>
        </td>
        <td className={`whitespace-nowrap px-5 py-2 text-right font-semibold tabular-nums text-foreground ${stickyCell}`} style={companyBalanceStyle(leader.companyBalance)}>
          {fmtOrDash(leader.companyBalance)}
        </td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground ${stickyCell}`}>{fmtOrDash(leader.balanceInside)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground ${stickyCell}`}>{fmtOrDash(leader.sdp)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums ${settlementClass(leader.settlementToday)} ${stickyCell}`}>{fmtOrDash(leader.settlementToday)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right font-medium tabular-nums text-foreground ${stickyCell}`}>{leader.shopCount}</td>
      </tr>
      {isExpanded &&
        leader.shops.map((shop, i) => (
          <tr key={`${shop.line}-${shop.shopName}-${i}`} className={`${styles.shopRow} border-b border-[#ECEFF3] dark:border-[#1A1E29]`}>
            {showLine && (
              <td className="px-5 py-1.5">
                <LinePill line={shop.line} />
              </td>
            )}
            <td className="truncate px-5 py-1.5 pl-11 text-[11px] text-muted-foreground">{shop.shopName}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right font-medium tabular-nums" style={companyBalanceStyle(shop.companyBalance)}>
              {fmtOrDash(shop.companyBalance)}
            </td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums text-muted-foreground">{fmtOrDash(shop.balanceInside)}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums text-muted-foreground">{fmtOrDash(shop.sdp)}</td>
            <td className={`whitespace-nowrap px-5 py-1.5 text-right tabular-nums ${settlementClass(shop.settlementToday)}`}>{fmtOrDash(shop.settlementToday)}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums" style={{ color: 'var(--dd-neg)' }}>
              {shop.noDataStreakDays} day{shop.noDataStreakDays === 1 ? '' : 's'}
            </td>
          </tr>
        ))}
      {isExpanded && (
        <tr ref={sentinelRef} aria-hidden="true">
          <td colSpan={showLine ? 7 : 6} style={{ padding: 0, border: 'none', height: 0, lineHeight: 0 }} />
        </tr>
      )}
    </tbody>
  );
}

export default function StagnantBalancesTab() {
  const [rawRows, setRawRows] = useState<StagnantBalanceRow[] | null>(null);
  const [rawRecovered, setRawRecovered] = useState<StagnantRecoveredEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StagnantView>('cashout');
  // Accordion — only one leader open at a time, same convention as
  // Discrepancy Summary.
  const [expandedLeader, setExpandedLeader] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const force = consumeForceRefresh();
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/stagnant-balance?t=${Date.now()}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (cancelled) return;
      setRawRows(json.rows ?? []);
      setRawRecovered(json.recovered ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const query = searchTerm.trim().toLowerCase();
  const searchedRows = rawRows && query ? rawRows.filter((r) => r.leader.toLowerCase().includes(query) || r.shopName.toLowerCase().includes(query)) : rawRows;
  const searchedRecovered = query ? rawRecovered.filter((e) => e.leader.toLowerCase().includes(query) || e.shopName.toLowerCase().includes(query)) : rawRecovered;
  const views = searchedRows ? buildAllStagnantViews(searchedRows, searchedRecovered) : null;
  const activeView = views ? views[selected] : null;
  const showLine = selected === 'group';

  function toggleLeader(key: string) {
    setExpandedLeader((current) => (current === key ? null : key));
  }

  async function handleExport() {
    if (!views) return;
    setExporting(true);
    try {
      await downloadStagnantBalanceExport(views);
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

      {loading || !activeView ? <SummaryBandSkeleton /> : <SummaryBand view={selected} buckets={activeView.buckets} cashoutDaysAsOf={activeView.cashoutDaysAsOf} />}

      <div className="relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-[#DEE1E8] dark:border-[#262B38]">
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[480px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            {showLine && <col style={{ width: '8%' }} />}
            <col style={{ width: showLine ? '24%' : '30%' }} />
            <col style={{ width: showLine ? '15%' : '16%' }} />
            <col style={{ width: showLine ? '15%' : '16%' }} />
            <col style={{ width: showLine ? '13%' : '13%' }} />
            <col style={{ width: showLine ? '13%' : '13%' }} />
            <col style={{ width: showLine ? '12%' : '12%' }} />
          </colgroup>
          <thead>
            <tr className="h-[38px]">
              {showLine && (
                <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-left text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                  Line
                </th>
              )}
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-left text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Leader / Shop Name
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Company Balance
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Balance Inside
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                SDP
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]" title="Settlement dated today">
                Settlement
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Shops / Days
              </th>
            </tr>
          </thead>
          {!loading && activeView && (
            <>
              {activeView.leaders.map((leader, i) => (
                <LeaderRows
                  key={leader.leader}
                  view={selected}
                  leader={leader}
                  isExpanded={expandedLeader === leader.leader}
                  onToggle={() => toggleLeader(leader.leader)}
                  rowIndex={i}
                />
              ))}
              {activeView.leaders.length === 0 && (
                <tbody>
                  <tr>
                    <td colSpan={showLine ? 7 : 6} className="px-5 py-10 text-center text-muted-foreground">
                      No shops have crossed the 3-day no-data threshold right now.
                    </td>
                  </tr>
                </tbody>
              )}
              <tbody>
                <tr className="sticky bottom-0 z-[2] h-[38px] font-medium">
                  {showLine && <td className="border-t-2 border-[#CBD5E1] bg-white px-5 dark:border-[#334155] dark:bg-[#12151D]" />}
                  <td className="border-t-2 border-[#CBD5E1] bg-white px-5 text-foreground dark:border-[#334155] dark:bg-[#12151D]">Total</td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]" style={companyBalanceStyle(activeView.totals.companyBalance)}>
                    {fmtOrDash(activeView.totals.companyBalance)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {fmtOrDash(activeView.totals.balanceInside)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {fmtOrDash(activeView.totals.sdp)}
                  </td>
                  <td className={`whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums dark:border-[#334155] dark:bg-[#12151D] ${settlementClass(activeView.totals.settlementToday)}`}>
                    {fmtOrDash(activeView.totals.settlementToday)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {activeView.totals.shopCount}
                  </td>
                </tr>
              </tbody>
            </>
          )}
        </table>
      </div>
    </div>
  );
}
