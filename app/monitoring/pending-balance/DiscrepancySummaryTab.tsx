'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, ChevronDown, Download, Loader2, Search } from 'lucide-react';
import styles from './discrepancySummary.module.css';
import {
  buildAllDiscrepancySummaryViews,
  type DiscrepancyLeaderGroup,
  type DiscrepancySummaryAllViews,
  type SummaryView,
} from '@/app/lib/discrepancySummaryAggregate';
import type { DiscrepancySummaryRow } from '@/app/lib/services/discrepancySummaryService';
import { downloadDiscrepancySummaryExport } from '@/app/lib/discrepancySummaryExport';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { consumeForceRefresh } from './forceRefresh';

// Same icon/label/button-shell convention as the Balance tab's (Agent
// Balance page) own Export button — duplicated locally rather than shared,
// since that button isn't exported from its page and this export is scoped
// to this tab only.
const EXPORT_BUTTON =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:pointer-events-none disabled:opacity-50 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Whole numbers, thousand separators — no decimals.
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
// Zero (and a leader row with nothing included) displays as "–", per spec.
function fmtOrDash(n: number): string {
  return Math.round(n) === 0 ? '–' : fmt(n);
}

const CARDS: { key: SummaryView; label: string }[] = [
  { key: 'cashout', label: 'Cashout' },
  { key: 'sendmoney', label: 'Send Money' },
  { key: 'group', label: 'Group Total' },
];

// Underline-tab switcher (label only, selected tab gets a blue underline)
// — left-aligned, no hairline/caption.
function SelectorTabsSkeleton() {
  return (
    <div className="flex items-center gap-8">
      {CARDS.map((c) => (
        <div key={c.key} className="dt-skeleton h-[13px] w-20 rounded" />
      ))}
    </div>
  );
}

function SelectorTabs({ selected, onSelect }: { selected: SummaryView; onSelect: (v: SummaryView) => void }) {
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

// Always exports all three sheets from the full (already-aggregated) data,
// regardless of which card is currently selected or which leader rows are
// expanded/collapsed on the page — per explicit spec.
function ExportButton({ views, exporting, onExport }: { views: DiscrepancySummaryAllViews | null; exporting: boolean; onExport: () => void }) {
  return (
    <button type="button" onClick={onExport} disabled={!views || exporting} aria-label="Export to Excel" title="Export" className={EXPORT_BUTTON}>
      {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      <span className="hidden xl:inline">Export</span>
    </button>
  );
}

// Same search-pill styling as the Balance tab's (Agent Balance page) own
// search box. Filters by Leader + Shop Name, same scope convention —
// duplicated locally for the same reason as EXPORT_BUTTON above.
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
  view: SummaryView;
  leader: DiscrepancyLeaderGroup;
  isExpanded: boolean;
  onToggle: () => void;
  rowIndex: number;
}) {
  const showLine = view === 'group';
  const clickable = leader.hasIncludedShops;

  // `position: sticky` on a table cell has no browser-native per-group
  // release boundary — it keeps sticking indefinitely past this leader's
  // own shop rows (a <tbody> wrapper doesn't bound it either, confirmed
  // live), visually overlapping whatever later leader's row scrolls up
  // into that same pinned slot. Compensated manually: a 0-height sentinel
  // row sits right after this leader's last shop row; once it's scrolled
  // above the sticky offset, this leader's own block is entirely behind
  // us, so stickiness is dropped and the row scrolls away normally like
  // any other leader row, instead of staying pinned forever.
  //
  // Directly recomputed on every `scroll` event, NOT an IntersectionObserver
  // — confirmed live that an IO firing only on ratio CHANGES misses a fast/
  // large scroll jump whose sampled ratio is 0% both before and after (the
  // sentinel passes fully through the visible band between two samples
  // without the browser ever reporting an intermediate crossing), silently
  // leaving the row stuck forever. A scroll-driven recompute always reads
  // the current true position instead of relying on an edge having been
  // observed.
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

    // 39px mirrors the 38px sticky header + 1px, matching where the row
    // would actually start sticking rather than the raw container edge.
    function recompute() {
      if (!sentinel || !scrollContainer) return;
      setPastOwnShops(sentinel.getBoundingClientRect().top < scrollContainer.getBoundingClientRect().top + 39);
    }
    recompute();
    scrollContainer.addEventListener('scroll', recompute, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', recompute);
  }, [isExpanded]);

  // Sticks right under the (38px-tall) header while its own shops scroll
  // underneath, so the leader's totals stay visible — only one leader can
  // ever be expanded at a time, so there's never a second sticky row to
  // conflict with. Needs a solid (non-transparent) per-cell background,
  // since the shop rows scroll underneath it.
  const stickyCell = isExpanded && !pastOwnShops ? 'sticky top-[38px] z-[1] bg-[#EEF4FF] dark:bg-[#151A28]' : '';

  return (
    <tbody>
      <tr
        className={`dt-row-stagger-in border-b border-[#ECEFF3] dark:border-[#1A1E29] ${clickable ? `${styles.leaderRow} ${isExpanded ? `${styles.leaderRowExpanded} ${styles.stickyLeaderRow}` : ''}` : ''}`}
        style={{ '--stagger-delay': `${Math.min(rowIndex, 12) * 30}ms` } as CSSProperties}
        onClick={clickable ? onToggle : undefined}
      >
        {showLine && <td className={`px-5 py-2 ${stickyCell}`} />}
        <td className={`overflow-hidden px-5 py-2 ${stickyCell}`}>
          <div className="flex items-center gap-1.5">
            {clickable ? (
              isExpanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <span className="inline-block w-[13px] shrink-0" />
            )}
            <span className="truncate font-medium text-foreground">{leader.leader}</span>
            {clickable && <span className="shrink-0 text-muted-foreground">({leader.shops.length})</span>}
          </div>
        </td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground ${stickyCell}`}>{fmtOrDash(leader.sdp)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground ${stickyCell}`}>{fmtOrDash(leader.companyBalance)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right tabular-nums text-foreground ${stickyCell}`}>{fmtOrDash(leader.balanceInside)}</td>
        <td className={`whitespace-nowrap px-5 py-2 text-right font-medium tabular-nums ${stickyCell}`} style={{ color: 'var(--dd-neg)' }}>
          {fmtOrDash(leader.agentWithdrawal)}
        </td>
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
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums text-muted-foreground">{fmtOrDash(shop.sdp)}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums text-muted-foreground">{fmtOrDash(shop.companyBalance)}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums text-muted-foreground">{fmtOrDash(shop.balanceInside)}</td>
            <td className="whitespace-nowrap px-5 py-1.5 text-right tabular-nums" style={{ color: 'var(--dd-neg)' }}>
              {fmtOrDash(shop.agentWithdrawal)}
            </td>
          </tr>
        ))}
      {isExpanded && (
        <tr ref={sentinelRef} aria-hidden="true">
          <td colSpan={showLine ? 6 : 5} style={{ padding: 0, border: 'none', height: 0, lineHeight: 0 }} />
        </tr>
      )}
    </tbody>
  );
}

export default function DiscrepancySummaryTab() {
  const [rawRows, setRawRows] = useState<DiscrepancySummaryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SummaryView>('cashout');
  // Accordion — only one leader open at a time (opening a new one closes
  // whichever was open), per explicit instruction.
  const [expandedLeader, setExpandedLeader] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const force = consumeForceRefresh();
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/discrepancy-summary?t=${Date.now()}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (cancelled) return;
      setRawRows(json.rows ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filters the raw rows BEFORE aggregation (rather than filtering the
  // already-grouped leaders/shops) so a leader's displayed subtotal always
  // matches exactly what's visible — e.g. searching a single shop code
  // narrows that leader down to just that one shop, with its total recomputed
  // from just that shop, not the leader's full (unfiltered) total. Export
  // reuses this same filtered `views`, so it naturally only contains
  // whatever the search currently matches.
  const query = searchTerm.trim().toLowerCase();
  const searchedRows = rawRows && query ? rawRows.filter((r) => r.leader.toLowerCase().includes(query) || r.shopName.toLowerCase().includes(query)) : rawRows;
  const views = searchedRows ? buildAllDiscrepancySummaryViews(searchedRows) : null;
  const activeView = views ? views[selected] : null;
  const showLine = selected === 'group';

  function toggleLeader(key: string) {
    setExpandedLeader((current) => (current === key ? null : key));
  }

  async function handleExport() {
    if (!views) return;
    setExporting(true);
    try {
      await downloadDiscrepancySummaryExport(views);
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

      {/* Same CashGo-style box (`overflow-auto`, `border-separate` + per-th
          `sticky top-0`). Was a `calc(100vh-Npx)` magic-number offset,
          which only matches the actual header height at one exact
          viewport/zoom combination and drifts on anything else — replaced
          with the same flex-1/min-h-0 fill pattern Agent Balance already
          uses (app/agentbal/page.tsx) so the box always exactly fills
          whatever space the page's own flex column leaves below the
          toolbar, regardless of screen size. */}
      <div className="relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-[#DEE1E8] dark:border-[#262B38]">
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            {showLine && <col style={{ width: '9%' }} />}
            <col style={{ width: showLine ? '14%' : '16%' }} />
            <col style={{ width: showLine ? '19.25%' : '21%' }} />
            <col style={{ width: showLine ? '19.25%' : '21%' }} />
            <col style={{ width: showLine ? '19.25%' : '21%' }} />
            <col style={{ width: showLine ? '19.25%' : '21%' }} />
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
                SDP
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Company Balance
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Balance Inside
              </th>
              <th className="sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-right text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Agent Withdrawal
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
              {/* Own <tbody> too — a table only sorts/scrolls its rows
                  correctly across multiple sibling <tbody>s this way, and
                  this row's `sticky bottom-0` needs the same real containing
                  block the fix above gives each leader's own <tbody>. */}
              <tbody>
                <tr className="sticky bottom-0 z-[2] h-[38px] font-medium">
                  {showLine && <td className="border-t-2 border-[#CBD5E1] bg-white px-5 dark:border-[#334155] dark:bg-[#12151D]" />}
                  <td className="border-t-2 border-[#CBD5E1] bg-white px-5 text-foreground dark:border-[#334155] dark:bg-[#12151D]">Total</td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {fmtOrDash(activeView.totals.sdp)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {fmtOrDash(activeView.totals.companyBalance)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums text-foreground dark:border-[#334155] dark:bg-[#12151D]">
                    {fmtOrDash(activeView.totals.balanceInside)}
                  </td>
                  <td className="whitespace-nowrap border-t-2 border-[#CBD5E1] bg-white px-5 text-right tabular-nums dark:border-[#334155] dark:bg-[#12151D]" style={{ color: 'var(--dd-neg)' }}>
                    {fmtOrDash(activeView.totals.agentWithdrawal)}
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
