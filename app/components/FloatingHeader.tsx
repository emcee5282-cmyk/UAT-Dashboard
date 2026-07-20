'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw, type LucideIcon } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { getActiveProduct, getCounterpartPath, isProductSwitchRoute } from '../lib/productRoutes';

type FloatingHeaderProps = {
  title: string;
  icon: LucideIcon;
  onRefresh: () => void;
  refreshing: boolean;
  // Page-specific buttons (Send-to-Telegram, collapse-cards toggle, etc.),
  // rendered before ThemeToggle/Refresh — every page has different extras.
  actions?: ReactNode;
};

// Shared floating header used across Dashboard, Balance Overview, and the 5
// Agent pages (Balance/Opening/Settlement/Top Up/Transfer Queue, both
// Cashout and Send Money variants). Replaces both the old per-page sticky/
// edge-to-edge header AND the sidebar's Cashout/Send Money switcher — this
// header is now the single place that switch lives, shown on every page
// except the shared Balance Overview (same URL for both products already).
export default function FloatingHeader({ title, icon: Icon, onRefresh, refreshing, actions }: FloatingHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeProduct = getActiveProduct(pathname, searchParams.get('product'));
  const showTabs = isProductSwitchRoute(pathname);

  const goToProduct = (target: 'cashout' | 'sendmoney') => {
    router.push(getCounterpartPath(pathname, target));
  };

  // Typography-only active state (bold + foreground) — no underline/pill/
  // background. Hover only steps the weight up one notch (medium ->
  // semibold), never scales/brightens — the fully-bold look is reserved for
  // the actually-selected tab. Size/weight combo (text-[12px] font-bold)
  // matches the Wallet Summary table's own wallet-name styling exactly, per
  // explicit request — the active tab's bold read as noticeably heavier at
  // the old 13px.
  const tabClass = (isActive: boolean) =>
    `text-[12px] transition-colors duration-200 ease-out ${
      isActive ? 'font-bold text-foreground' : 'font-medium text-muted-foreground hover:font-semibold hover:text-foreground/80'
    }`;

  return (
    <div className="sticky top-4 z-30 mx-4 md:mx-8">
      <header className="rounded-xl border border-border bg-white/95 shadow-lg backdrop-blur-sm dark:bg-[#0d1117]/95">
        {/* Mobile: a plain flex row — title (truncating) on the left, actions
            on the right, no center tabs competing for space here at all.
            Desktop (md+): reverts to the original 3-column grid with tabs
            centered in the middle column. The old `grid-cols-3` on mobile
            gave the tabs an equal-width column regardless of their actual
            content width, and since nothing clipped them, "Cashout / Send
            Money" simply overflowed that column and rendered on top of the
            title text. */}
        <div className="flex h-14 items-center justify-between gap-2 pl-14 pr-4 md:grid md:grid-cols-3 md:pl-5 md:pr-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white"
              style={{ background: 'var(--product-accent)' }}
            >
              <Icon size={14} />
            </div>
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</span>
          </div>

          <div className="hidden md:flex md:justify-center">
            {showTabs && (
              <div className="flex items-center gap-7">
                <button type="button" onClick={() => goToProduct('cashout')} className={tabClass(activeProduct === 'cashout')}>
                  Cashout
                </button>
                <button type="button" onClick={() => goToProduct('sendmoney')} className={tabClass(activeProduct === 'sendmoney')}>
                  Send Money
                </button>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2">
            {actions}
            <ThemeToggle />
            <button
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh"
              title="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/60 text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Mobile-only tabs row — full header width to breathe, shown below
            the main row instead of squeezed into it. */}
        {showTabs && (
          <div className="flex items-center justify-center gap-7 border-t border-border py-2 md:hidden">
            <button type="button" onClick={() => goToProduct('cashout')} className={tabClass(activeProduct === 'cashout')}>
              Cashout
            </button>
            <button type="button" onClick={() => goToProduct('sendmoney')} className={tabClass(activeProduct === 'sendmoney')}>
              Send Money
            </button>
          </div>
        )}
      </header>
    </div>
  );
}
