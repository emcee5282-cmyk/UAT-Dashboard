'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { getActiveProduct, getCounterpartPath } from '@/app/lib/productRoutes';
import {
  LayoutDashboard,
  Wallet,
  BookOpen,
  ArrowLeftRight,
  PlusCircle,
  Menu,
  X,
  Shuffle,
  Settings,
  Home,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const GeoLogo = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-[15px] w-[15px]">
    {/* Bar 1 — shortest, 55% */}
    <rect x="1" y="14" width="6" height="6" rx="0.5" fill="white" fillOpacity="0.55" />
    {/* Bar 2 — mid, 80% */}
    <rect x="9" y="9" width="6" height="11" rx="0.5" fill="white" fillOpacity="0.80" />
    {/* Bar 3 — tallest, 100% */}
    <rect x="17" y="4" width="6" height="16" rx="0.5" fill="white" />
    {/* Trend line */}
    <polyline points="4,14 12,9 20,4" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    {/* Ring matching the tile bg so dot lifts off the white bar */}
    <circle cx="20" cy="4" r="2" fill="var(--product-accent)" />
    {/* Emerald dot */}
    <circle cx="20" cy="4" r="1.4" fill="#10b981" />
  </svg>
);

// Hover tooltip shown ONLY while the dock is collapsed (once expanded, the
// inline label already covers this — see DockRow below). Parent must have
// `group relative`.
function DockTooltip({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-white px-1.5 py-0.5 text-[10px] font-medium text-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 dark:bg-[#0d1117]">
      {label}
    </span>
  );
}

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

// The core fix for "icons jump when the sidebar expands": every row renders
// BOTH the icon and its label at all times — nothing is conditionally
// mounted/unmounted based on `expanded`. The icon sits in its own
// fixed-size (h-9 w-9) box that never moves; the label is appended right
// after it and is purely an opacity/translate fade — never a width/margin
// change on the icon's own box. The outer dock container is what actually
// animates (width + overflow-hidden), which is what clips the label out of
// view while collapsed, not any per-row logic. Because the label markup is
// always rendered (just visually faded), row height never changes either.
function DockRow({
  href,
  onClick,
  icon: Icon,
  label,
  active,
  expanded,
  disabled,
  badge,
  tooltip = true,
}: {
  href?: string;
  onClick?: () => void;
  icon: IconType;
  label: string;
  active?: boolean;
  expanded: boolean;
  disabled?: boolean;
  badge?: number | null;
  tooltip?: boolean;
}) {
  // A block-level `flex` row has `width: auto`, which fills 100% of its
  // (stretched) parent regardless of content — that's why the active-state
  // fill was a full-width 47×32 rectangle even though the label next to the
  // icon is invisible while collapsed. `w-fit` while collapsed makes the row
  // shrink-wrap its actual visible content (icon + padding) into a clean
  // near-square instead; the label's own max-w-0 (below) ensures it truly
  // contributes zero width at that point rather than just being invisible.
  const rowClassName = cn(
    'flex h-8 items-center rounded-lg px-1.5 text-[11px] font-medium whitespace-nowrap transition-colors duration-300 ease-in-out',
    expanded ? 'w-full' : 'w-fit',
    disabled ? 'cursor-not-allowed text-muted-foreground' : 'hover:bg-muted'
  );
  const style = active ? { background: '#0f172a', color: 'white' } : undefined;

  const inner = (
    <>
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
        <Icon size={13} strokeWidth={1.75} />
        {!!badge && badge > 0 && (
          <Badge className="absolute -right-0.5 -top-0.5 h-3.5 min-w-3.5 justify-center rounded-full px-1 text-[8px]">
            {badge > 99 ? '99+' : badge}
          </Badge>
        )}
      </span>
      <span
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? 'ml-2 max-w-[140px] translate-x-0 opacity-100' : 'ml-0 max-w-0 -translate-x-1 opacity-0'
        }`}
      >
        {label}
      </span>
    </>
  );

  return (
    <div className="group relative">
      {href ? (
        <Link href={href} onClick={onClick} aria-label={label} className={rowClassName} style={style}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={rowClassName} style={style}>
          {inner}
        </button>
      )}
      {tooltip && !expanded && <DockTooltip label={label} />}
    </div>
  );
}
import { useEffect, useState, type ComponentType } from 'react';
import { fetchTransferQueueCount, fetchSendMoneyTransferQueueCount } from '@/app/lib/transferQueueCount';

// Flat icon list for the desktop floating dock — same destinations as the
// mobile drawer's nav above (Dashboard is the product's own root page, e.g.
// Cash Out Wallets / Send Money's equivalent; Overview is the shared,
// product-agnostic page, handled separately below), just without the
// "Agent" grouping label (no room for a submenu accordion in an icon-only
// dock).
const DOCK_ITEMS = [
  { href: '/agentbal', label: 'Balance', icon: Wallet },
  { href: '/summary', label: 'Opening', icon: BookOpen },
  { href: '/stlm', label: 'Settlement', icon: ArrowLeftRight },
  { href: '/topup', label: 'Top Up', icon: PlusCircle },
  { href: '/transfer-queue', label: 'Transfer Queue', icon: Shuffle, isTransferQueue: true },
];

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Desktop-only: the compact icon dock is the default state, always
  // visible. Clicking its toggle opens this full labeled panel instead —
  // a separate view, not a collapse/expand of the same dock — which stays
  // open regardless of hover/mouse-leave until explicitly closed (X button
  // or the toggle again), per explicit instruction that it must persist.
  const [panelOpen, setPanelOpen] = useState(false);
  // URL is the single source of truth for the active product — never client
  // state. The ?product= param only matters on shared routes (Balance
  // Overview), where the path alone can't distinguish the two.
  const activeProduct = getActiveProduct(pathname, searchParams.get('product'));
  const [cashoutTransferQueueCount, setCashoutTransferQueueCount] = useState<number | null>(null);
  const [sendMoneyTransferQueueCount, setSendMoneyTransferQueueCount] = useState<number | null>(null);

  const resolveHref = (canonicalCashoutHref: string) =>
    activeProduct === 'cashout' ? canonicalCashoutHref : getCounterpartPath(canonicalCashoutHref, 'sendmoney');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const load = () => {
      fetchTransferQueueCount()
        .then(setCashoutTransferQueueCount)
        .catch(() => setCashoutTransferQueueCount(null));
      fetchSendMoneyTransferQueueCount()
        .then(setSendMoneyTransferQueueCount)
        .catch(() => setSendMoneyTransferQueueCount(null));
    };

    load();
    const interval = setInterval(load, 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const isMockup = pathname.startsWith('/mockup');
  const rawCount = activeProduct === 'cashout' ? cashoutTransferQueueCount : sendMoneyTransferQueueCount;
  const displayCount = isMockup ? 150 : rawCount;

  const overviewHref = resolveHref('/');
  const overviewActive = pathname === overviewHref;

  return (
    <>
      {/* Mobile — unchanged: hamburger + slide-in labeled drawer. */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-7 z-50 rounded-lg border border-border bg-white/90 p-2 text-muted-foreground shadow-sm dark:bg-[#0d1117]/90 md:hidden"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-foreground/20 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`fixed left-0 top-0 z-50 flex h-full w-60 flex-col border-r border-border bg-white text-foreground transition-transform duration-300 dark:bg-[#0d1117] md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[49px] shrink-0 items-center gap-3 border-b border-border px-4">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-white/10"
            style={{ background: '#0f172a' }}
          >
            <GeoLogo />
          </div>
          <div className="overflow-hidden">
            <p className="whitespace-nowrap text-[11px] font-semibold leading-tight text-foreground">Operations</p>
            <p className="whitespace-nowrap text-[8px] leading-snug text-muted-foreground/70">Real-time Dashboard</p>
          </div>
          <button onClick={() => setMobileOpen(false)} className="ml-auto text-muted-foreground hover:text-foreground">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-2 py-3">
          {!mounted ? (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-8 rounded-lg" />
              ))}
            </div>
          ) : (
            <>
              {/* Same flat row list as the desktop expanded panel (DockRow,
                  expanded=true) — no accordion/grouping box. Kept in sync by
                  reusing the exact component instead of a parallel markup. */}
              <DockRow
                href={overviewHref}
                icon={LayoutDashboard}
                label="Dashboard"
                active={overviewActive}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />
              <DockRow
                href={resolveHref('/balance-overview')}
                icon={Home}
                label="SSP Overview"
                active={pathname === resolveHref('/balance-overview')}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />
              {DOCK_ITEMS.map((item) => (
                <DockRow
                  key={item.href}
                  href={resolveHref(item.href)}
                  icon={item.icon}
                  label={item.label}
                  active={pathname === resolveHref(item.href)}
                  expanded
                  tooltip={false}
                  badge={item.isTransferQueue ? displayCount : null}
                  onClick={() => setMobileOpen(false)}
                />
              ))}
              <DockRow icon={Settings} label="Settings · Soon" expanded tooltip={false} disabled />
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-3 py-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] font-bold text-slate-900 dark:bg-white/10 dark:text-white">
              OP
            </div>
            <div className="min-w-0 overflow-hidden whitespace-nowrap">
              <p className="truncate text-[12px] font-semibold text-foreground">Operations Admin</p>
              <p className="truncate text-[10px] text-muted-foreground">admin@operations.com</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Desktop — ONE persistent container; only its width animates
          between collapsed and expanded. Icons never move: every row keeps
          the exact same fixed-size icon box (h-9 w-9) at the exact same
          left offset (px-[9px] on the row) in both states — only the
          label next to it fades/slides in, and only because the outer
          container is wide enough to reveal it (overflow-hidden clips it
          otherwise). Row order is fixed and identical regardless of state:
          Menu toggle, brand, Dashboard, Overview, product switch, Balance,
          Opening, Settlement, Top Up, Transfer Queue, Settings, avatar. */}
      <div
        className={`fixed left-0 top-0 z-[60] hidden h-screen overflow-hidden border-r border-border bg-white shadow-md transition-[width] duration-300 ease-in-out dark:bg-[#0d1117] md:block ${
          panelOpen ? 'w-52' : 'w-14'
        }`}
      >
        <div className="flex h-full flex-col gap-1 p-1">
          {/* Brand — decorative logo, not a link. The chevron at the end is
              the ONLY open/close control now (replaces the old separate
              Menu/X toggle row). Fixed row height so collapsing/expanding
              never changes its own size. */}
          <div className="relative mb-2 flex h-9 items-center gap-2 rounded-lg px-2">
            <div
              className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-white/10"
              style={{ background: '#0f172a' }}
            >
              <GeoLogo />
            </div>
            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                panelOpen ? 'max-w-[120px] translate-x-0 opacity-100' : 'max-w-0 -translate-x-1 opacity-0'
              }`}
            >
              <p className="whitespace-nowrap text-[11px] font-semibold leading-tight text-foreground">Operations</p>
              <p className="whitespace-nowrap text-[8px] leading-snug text-muted-foreground/70">Real-time Dashboard</p>
            </div>
            {panelOpen && (
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Collapse menu"
                title="Collapse menu"
                className="absolute right-1 top-1/2 flex h-5 w-5 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronLeft size={13} />
              </button>
            )}
          </div>

          <DockRow href={overviewHref} icon={LayoutDashboard} label="Dashboard" active={overviewActive} expanded={panelOpen} />

          {mounted && (() => {
            const dashboardHref = resolveHref('/balance-overview');
            return (
              <DockRow
                href={dashboardHref}
                icon={Home}
                label="SSP Overview"
                active={pathname === dashboardHref}
                expanded={panelOpen}
              />
            );
          })()}

          {mounted && DOCK_ITEMS.map((item) => (
            <DockRow
              key={item.href}
              href={resolveHref(item.href)}
              icon={item.icon}
              label={item.label}
              active={pathname === resolveHref(item.href)}
              expanded={panelOpen}
              badge={item.isTransferQueue ? displayCount : null}
            />
          ))}

          <DockRow icon={Settings} label="Settings · Soon" expanded={panelOpen} disabled />

          <div className="relative mt-auto flex items-center gap-2 rounded-lg border-t border-border px-1.5 pb-1 pt-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[7px] font-bold text-slate-900 dark:bg-white/10 dark:text-white">
                OP
              </div>
            </div>
            <div
              className={`min-w-0 transition-all duration-300 ease-in-out ${
                panelOpen ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
              }`}
            >
              <p className="whitespace-nowrap text-[10px] font-semibold text-foreground">Operations Admin</p>
              <p className="whitespace-nowrap text-[8px] text-muted-foreground">admin@operations.com</p>
            </div>
          </div>
        </div>
      </div>

      {/* Chevron badge rendered OUTSIDE the sidebar's overflow-hidden box so it
          can overlap past the collapsed edge without the sidebar itself
          changing width or clipping it. Position mirrors the brand button's
          fixed location (icons never move regardless of panelOpen). */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-label="Expand menu"
          title="Expand menu"
          className="fixed left-12 top-[22px] z-[61] hidden h-4 w-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-white text-slate-900 shadow-sm md:flex dark:bg-[#0d1117] dark:text-white"
        >
          <ChevronRight size={10} />
        </button>
      )}
    </>
  );
}
