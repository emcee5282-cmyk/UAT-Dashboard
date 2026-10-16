'use client';

// Monitoring > Pending Balance — hosts Discrepancy Summary, moved out of
// Daily Transaction Entry (it's a monitoring view, not a data-entry step;
// see that page's own PAGE_TABS comment). Copies that page's shell exactly:
// same PageHeader (title/refresh/theme/Admin menu), same pill tab switcher
// (now the shared PillTabs component — Daily Transaction Entry used to
// hardcode this switcher inline), and the same page-scoped Manrope/Space
// Grotesk font exception + --dd-pos/--dd-neg/--ink-*/--hair token block,
// which DiscrepancySummaryTab (moved here as-is) depends on for its
// tabular-nums font and negative-value coloring.
import { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Manrope, Space_Grotesk } from 'next/font/google';
import { Moon, Sun } from 'lucide-react';
import PageHeader from '@/app/components/PageHeader';
import PillTabs from '@/app/components/PillTabs';
import AccountMenu from '@/app/components/AccountMenu';
import { useTheme } from '@/app/components/ThemeProvider';
import DiscrepancySummaryTab from './DiscrepancySummaryTab';
import UnreconciledBalanceTab from './UnreconciledBalanceTab';
import StagnantBalancesTab from './StagnantBalancesTab';
import SendToTgButton from './SendToTgButton';
import SendUnreconciledToTgButton from './SendUnreconciledToTgButton';
import { markForceRefresh } from './forceRefresh';

const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

// A tab array/config (not a single hardcoded view) so more Monitoring tabs
// can land on this page later without restructuring.
type TabKey = 'discrepancy' | 'unreconciled' | 'stagnant';
const PAGE_TABS: { key: TabKey; label: string }[] = [
  { key: 'discrepancy', label: 'Discrepancy Summary' },
  { key: 'unreconciled', label: 'Unreconciled Balance' },
  { key: 'stagnant', label: 'Stagnant Balances' },
];

export default function PendingBalancePage() {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The URL's own `?tab=` is the single source of truth for which tab is
  // active — not local component state — so a literal page refresh (which
  // keeps the same URL) lands back on the same tab, while a fresh
  // navigation into this page from elsewhere (e.g. the Balances page's own
  // nav link, which points here with no query string) always starts at the
  // default tab, per explicit instruction.
  const tabParam = searchParams.get('tab');
  const tab: TabKey = tabParam === 'unreconciled' || tabParam === 'stagnant' ? tabParam : 'discrepancy';

  function setTab(next: TabKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'discrepancy') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const [spinning, setSpinning] = useState(false);

  // Same 600ms min-spin + full reload convention as Daily Transaction
  // Entry's own Refresh button. markForceRefresh() is this button's own
  // explicit "bypass the cache" signal — a plain browser reload (F5) does
  // NOT set this, only this button does, per explicit instruction.
  function handleRefresh() {
    setSpinning(true);
    markForceRefresh();
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <div
      className={`dd-page h-screen w-full flex flex-col overflow-hidden bg-[#F7F8FA] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#0A0C11] dark:text-white ${manrope.variable} ${spaceGrotesk.variable}`}
    >
      <style>{`
        .dd-page :where(h1, h2, h3, p, span, td, th) { line-height: normal; }
        .dd-page {
          --dd-pos: #16A34A; --dd-neg: #E23D3D; --dd-pos-dim: rgba(22,163,74,.10); --dd-neg-dim: rgba(226,61,61,.10);
          --ink-0: #F7F8FA; --ink-1: #FFFFFF; --ink-2: #F1F2F5; --hair: #DDE0E7;
          --text-hi: #1A1D23; --text-mid: #6B7280; --text-low: #9CA3AF;
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .dark .dd-page {
          --dd-pos: #34D399; --dd-neg: #F4665A; --dd-pos-dim: rgba(52,211,153,.12); --dd-neg-dim: rgba(244,102,90,.12);
          --ink-0: #0A0C11; --ink-1: #12151D; --ink-2: #1A1E29; --hair: #262B38;
          --text-hi: #F3F4F7; --text-mid: #9198AC; --text-low: #565C70;
        }
        .dd-page .tabular-nums { font-family: var(--font-space-grotesk), ui-monospace, monospace; }
        main:has(.dd-page) {
          background: #F7F8FA;
        }
        .dark main:has(.dd-page) {
          background: #0A0C11;
        }
      `}</style>
      <main className="flex flex-1 flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col min-h-0 pt-4">
          <PageHeader
            title="Pending Balance"
            containerless
            stickyOffset={16}
            actions={
              <>
                {tab === 'discrepancy' && <SendToTgButton />}
                {tab === 'unreconciled' && <SendUnreconciledToTgButton />}
                <button
                  onClick={handleRefresh}
                  disabled={spinning}
                  aria-label="Refresh"
                  title="Refresh"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] disabled:opacity-50 dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="11"
                    height="11"
                    fill="none"
                    className={spinning ? 'animate-spin' : ''}
                    style={{ color: spinning ? 'var(--ui-accent)' : undefined }}
                  >
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={toggleTheme}
                  aria-label="Toggle light and dark mode"
                  title="Toggle light and dark mode"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
                </button>
                <AccountMenu compact />
              </>
            }
          />

          {/* PageHeader's own mb-[22px] (shared, used by every containerless
              page) leaves a bigger gap below its divider line than the
              15px it leaves above that same line inside the header itself
              — pulled up by the 7px difference here, scoped to this page
              only, rather than changing the shared component's margin for
              every page that uses it. */}
          <div className="-mt-[7px]">
            <PillTabs tabs={PAGE_TABS} active={tab} onSelect={setTab} />
          </div>

          {tab === 'discrepancy' && <DiscrepancySummaryTab />}
          {tab === 'unreconciled' && <UnreconciledBalanceTab />}
          {tab === 'stagnant' && <StagnantBalancesTab />}
        </div>
      </main>
    </div>
  );
}
