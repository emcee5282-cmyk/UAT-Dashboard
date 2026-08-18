'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ComponentType } from 'react';
import { getActiveProduct, getCounterpartPath } from '@/app/lib/productRoutes';
import { fetchTransferQueueCount, fetchSendMoneyTransferQueueCount } from '@/app/lib/transferQueueCount';
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
  Flag,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SIDEBAR_SYNC_DURATION_CLASS } from '@/app/design-system/transitions';
import AccountMenu from './AccountMenu';

const BrandLogo = () => (
  <Image src="/kibo-ui-light.svg" alt="" width={36} height={36} className="h-full w-full rounded-lg object-contain p-1.5" unoptimized />
);

// Hover tooltip shown ONLY while the dock is collapsed (once expanded, the
// inline label already covers this — see DockRow below). Parent must have
// `group relative`.
function DockTooltip({ label }: { label: string }) {
  return (
    // delay-0 at rest so leaving hover dismisses it immediately; the
    // 250ms delay only applies going the other way (group-hover:delay-*),
    // so a cursor just passing over the dock doesn't flash a tooltip for
    // every row it crosses.
    <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-white px-1.5 py-0.5 text-[10px] font-medium text-foreground opacity-0 shadow-md transition-opacity delay-0 duration-150 group-hover:opacity-100 group-hover:delay-[250ms] dark:bg-[#0d1117]">
      {label}
    </span>
  );
}

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

// The core fix for "icons jump when the sidebar expands": every row renders
// BOTH the icon and its label at all times — nothing is conditionally
// mounted/unmounted based on `expanded`. The icon sits in its own
// fixed-size (h-7 w-7) box that never moves; the label is appended right
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
    'flex h-10 items-center rounded-lg px-2.5 text-[11px] font-medium whitespace-nowrap transition-[transform,background-color,box-shadow] duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]',
    expanded ? 'w-full' : 'w-fit',
    disabled && 'cursor-not-allowed text-muted-foreground',
    // A flat `hover:bg-muted` reads as a button press, not a highlight — a
    // low-opacity tint plus a 2px nudge reads as "this row is selectable"
    // without competing with the actual active state.
    !disabled && !active && 'hover:translate-x-[2px] hover:bg-[#0f172a]/[0.05] dark:hover:bg-white/[0.06]',
    // Soft indigo fill — same indigo regardless of active product (was
    // --product-accent, flipping indigo/teal per product; kept as one
    // consistent color across Cashout and Send Money per explicit
    // instruction) — replaces the old solid navy block, paired with the
    // left accent bar below instead of a full rectangle.
    active && 'bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.12)] font-semibold text-indigo-600 dark:text-indigo-400 shadow-[0_1px_3px_rgba(15,23,42,0.08)]'
  );

  const inner = (
    <>
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        <Icon size={16} strokeWidth={1.75} />
        {!!badge && badge > 0 && (
          // Overrides the default Badge's bg-primary fill — same softened
          // slate as the inactive nav tone, for one consistent "dark" tone
          // across the sidebar instead of two different blacks. leading-
          // none keeps the digit centered instead of drifting from the
          // default line-height in a box this small.
          <Badge className="absolute -right-1 -top-1 h-3.5 min-w-3.5 justify-center rounded-full bg-[#1e293b] px-1 text-[8px] leading-none text-white dark:bg-white/20">
            {badge > 99 ? '99+' : badge}
          </Badge>
        )}
      </span>
      <span
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? 'ml-2 max-w-[170px] translate-x-0 opacity-100' : 'ml-0 max-w-0 -translate-x-1 opacity-0'
        }`}
      >
        {label}
      </span>
    </>
  );

  return (
    <div className="group relative">
      {active && (
        <span
          className="pointer-events-none absolute left-0 top-1/2 z-10 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-[#4f46e5]"
        />
      )}
      {href ? (
        <Link href={href} onClick={onClick} aria-label={label} aria-current={active ? 'page' : undefined} className={rowClassName}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={rowClassName}>
          {inner}
        </button>
      )}
      {tooltip && !expanded && <DockTooltip label={label} />}
    </div>
  );
}

// Uppercase, muted group label shown above each nav group while expanded;
// while collapsed there's no room for text, so a thin divider stands in as
// the grouping signal instead. `first` skips the divider/extra top spacing
// for the group right under the header, which already has its own divider.
function NavSection({ label, expanded, first }: { label: string; expanded: boolean; first?: boolean }) {
  if (expanded) {
    return (
      <p className={`px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 ${first ? 'pb-1 pt-1' : 'pb-1 pt-3'}`}>
        {label}
      </p>
    );
  }
  return first ? null : <div className="mx-2.5 my-1 border-t border-border/70" />;
}

// Same destinations as before (Dashboard is the product's own root page,
// e.g. Cash Out Wallets / Send Money's equivalent; Overview is the shared,
// product-agnostic page, handled separately below), just grouped under
// section labels now instead of one flat list.
const OPERATIONS_ITEMS = [
  { href: '/agentbal', label: 'Balance', icon: Wallet },
  { href: '/summary', label: 'Opening', icon: BookOpen },
  { href: '/stlm', label: 'Settlement', icon: ArrowLeftRight },
  { href: '/topup', label: 'Top Up', icon: PlusCircle },
];

const MONITORING_ITEMS = [
  { href: '/transfer-queue', label: 'Transfer Queue', icon: Shuffle, isTransferQueue: true },
  { href: '/wallet-status', label: 'Wallet Status', icon: Flag, isTransferQueue: false },
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
    if (localStorage.getItem('sidebarPanelOpen') === 'true') setPanelOpen(true);
  }, []);

  // Persist the expanded/collapsed choice across reloads — gated on
  // `mounted` so this can't fire during the initial render (before the
  // read above has had a chance to apply) and clobber a saved "true" back
  // to the default "false".
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('sidebarPanelOpen', String(panelOpen));
  }, [panelOpen, mounted]);

  // Mirrors panelOpen into a CSS variable (defined in globals.css) so
  // AppShell's main content can offset itself to match — a plain value
  // swap between the two known widths, not a measured/calculated one, so
  // this doesn't need a resize listener or any layout math.
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', panelOpen ? '250px' : '72px');
  }, [panelOpen]);

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

      <aside className={`fixed left-0 top-0 z-50 flex h-full w-[250px] flex-col border-r border-border bg-white text-foreground transition-transform duration-300 dark:bg-[#0d1117] md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-border px-4">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border"
          >
            <BrandLogo />
          </div>
          <div className="overflow-hidden">
            <p className="whitespace-nowrap text-[12px] font-semibold leading-tight text-foreground">Operations</p>
            <p className="whitespace-nowrap text-[9px] leading-snug text-muted-foreground/70">Operations Dashboard</p>
          </div>
          <button onClick={() => setMobileOpen(false)} className="ml-auto text-muted-foreground hover:text-foreground">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2 py-3">
          {!mounted ? (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-10 rounded-lg" />
              ))}
            </div>
          ) : (
            <>
              {/* Same grouped row list as the desktop expanded panel
                  (DockRow, expanded=true) — kept in sync by reusing the
                  exact NavSection/DockRow components instead of a parallel
                  markup. */}
              <NavSection label="OVERVIEW" expanded first />
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

              <NavSection label="OPERATIONS" expanded />
              {OPERATIONS_ITEMS.map((item) => (
                <DockRow
                  key={item.href}
                  href={resolveHref(item.href)}
                  icon={item.icon}
                  label={item.label}
                  active={pathname === resolveHref(item.href)}
                  expanded
                  tooltip={false}
                  onClick={() => setMobileOpen(false)}
                />
              ))}

              <NavSection label="MONITORING" expanded />
              {MONITORING_ITEMS.map((item) => (
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

              <NavSection label="SETTINGS" expanded />
              <DockRow
                href="/settings"
                icon={Settings}
                label="Settings"
                active={pathname === '/settings'}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />
            </>
          )}
        </div>

        {/* Quick-access copy for the drawer itself — pages also render
            AccountMenu inline in their own header row (which shows on
            mobile too), this is just a shortcut so it's reachable without
            leaving the drawer. */}
        <div className="shrink-0 border-t border-border px-3 py-3">
          <AccountMenu className="w-full" />
        </div>
      </aside>

      {/* Desktop — ONE persistent container; only its width animates
          between collapsed and expanded. Icons never move: every row keeps
          the exact same fixed-size icon box (h-8 w-8) at the exact same
          left offset (px-2.5 on the row) in both states — only the
          label next to it fades/slides in, and only because the outer
          container is wide enough to reveal it (overflow-hidden clips it
          otherwise). Row order is fixed and identical regardless of state:
          Menu toggle, brand, Dashboard, Overview, Balance, Opening,
          Settlement, Top Up, Transfer Queue, Settings, avatar — grouped
          under OVERVIEW / OPERATIONS / MONITORING / SETTINGS labels. */}
      <div
        className={`fixed left-0 top-0 z-[60] hidden h-screen overflow-hidden border-r border-border bg-white shadow-[1px_0_3px_rgba(0,0,0,0.04)] transition-[width] ${SIDEBAR_SYNC_DURATION_CLASS} ease-in-out dark:bg-[#0d1117] md:block ${
          panelOpen ? 'w-[250px]' : 'w-[72px]'
        }`}
      >
        <div className="flex h-full flex-col gap-2 p-2">
          {/* Brand — decorative logo, not a link. The chevron at the end is
              the ONLY open/close control now (replaces the old separate
              Menu/X toggle row). Fixed row height so collapsing/expanding
              never changes its own size. No divider below (removed per
              explicit instruction) — this block just sits flush above the
              nav now. */}
          {/* px-2.5 — matches every nav row and the footer avatar exactly,
              so the logo icon's left edge lines up with every icon below
              it. */}
          <div className="mb-1 pb-3">
            <div className="relative flex h-14 items-center gap-2.5 rounded-lg px-2.5">
              <div
                className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border"
              >
                <BrandLogo />
              </div>
              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  panelOpen ? 'max-w-[140px] translate-x-0 opacity-100' : 'max-w-0 -translate-x-1 opacity-0'
                }`}
              >
                <p className="whitespace-nowrap text-[12px] font-semibold leading-tight text-foreground">Operations</p>
                <p className="whitespace-nowrap text-[9px] leading-snug text-muted-foreground/70">Operations Dashboard</p>
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
          </div>

          <NavSection label="OVERVIEW" expanded={panelOpen} first />
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

          {mounted && (
            <>
              <NavSection label="OPERATIONS" expanded={panelOpen} />
              {OPERATIONS_ITEMS.map((item) => (
                <DockRow
                  key={item.href}
                  href={resolveHref(item.href)}
                  icon={item.icon}
                  label={item.label}
                  active={pathname === resolveHref(item.href)}
                  expanded={panelOpen}
                />
              ))}

              <NavSection label="MONITORING" expanded={panelOpen} />
              {MONITORING_ITEMS.map((item) => (
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

            </>
          )}

          <NavSection label="SETTINGS" expanded={panelOpen} />
          <DockRow
            href="/settings"
            icon={Settings}
            label="Settings"
            active={pathname === '/settings'}
            expanded={panelOpen}
          />
        </div>
      </div>

      {/* Chevron badge rendered OUTSIDE the sidebar's overflow-hidden box so it
          can overlap past the collapsed edge without the sidebar itself
          changing width or clipping it. top-[36px] mirrors the brand row's
          own vertical center (8px outer padding + half of its h-14/56px
          height) so it reads as part of that row instead of a floating
          chip. left-[64px] sits at the collapsed 72px rail's edge minus
          half the button's own width, so it straddles the edge. */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-label="Expand menu"
          title="Expand menu"
          className="fixed left-[64px] top-[36px] z-[61] hidden h-4 w-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-white text-slate-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)] md:flex dark:bg-[#0d1117] dark:text-white"
        >
          <ChevronRight size={10} />
        </button>
      )}
    </>
  );
}
