'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ComponentType } from 'react';
import { getActiveProduct, getCounterpartPath } from '@/app/lib/productRoutes';
import { fetchTransferQueueCount, fetchSendMoneyTransferQueueCount } from '@/app/lib/transferQueueCount';
import { Menu, X, ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SIDEBAR_SYNC_DURATION_CLASS } from '@/app/design-system/transitions';
import AccountMenu from './AccountMenu';

const BrandLogo = () => (
  <Image src="/kibo-ui-light.svg" alt="" width={36} height={36} className="h-full w-full rounded-lg object-contain p-1.5" unoptimized />
);

// ---- Nav icons — copied verbatim (same viewBox/paths/stroke-width) from
// the Dashboard Demo mockup (public/dashboard-demo.html) per explicit
// instruction to match its sidebar exactly, in place of the lucide-react
// icon set this dock used before.
type IconProps = { size?: number; strokeWidth?: number; className?: string };

const IconDashboard = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={strokeWidth} />
  </svg>
);
const IconBalance = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <rect x="3" y="7" width="18" height="13" rx="1.6" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M3 11h18M8 4h8" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);
const IconOpening = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M4 4h16v16H4z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);
const IconSettlement = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M4 7h16M16 3l4 4-4 4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 17H4M8 21l-4-4 4-4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconTopUp = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);
const IconDailyEntry = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    <path d="M14 3v5h5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    <path d="M8 13h8M8 17h5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);
const IconTransferQueue = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M17 7l4 4-4 4M7 17l-4-4 4-4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 12h18" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);
const IconWalletStatus = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M3 7a2 2 0 012-2h13a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    <path d="M3 9h18" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M15 14h3" stroke="currentColor" strokeWidth={strokeWidth + 0.2} strokeLinecap="round" />
  </svg>
);
const IconSettings = ({ size = 15, strokeWidth = 1.3, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M19 12a7 7 0 00-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 00-2.42-1.4L13.6 3h-4l-.48 2.14a7 7 0 00-2.42 1.4l-2.36-.95-2 3.46 2 1.55a7 7 0 000 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 002.42 1.4L9.6 21h4l.48-2.14a7 7 0 002.42-1.4l2.36.95 2-3.46-2-1.55c.09-.46.14-.93.14-1.4z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
  </svg>
);
// Staff/admin-only nav entry (see role fetch below) — a speech-bubble
// shape, matching this dock's existing simple line-art icon convention.
const IconTickets = ({ size = 15, strokeWidth = 1.6, className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" width={size} height={size} className={className}>
    <path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-4 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
  </svg>
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
    <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-[#E7E9EE] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#1A1D23] opacity-0 shadow-md transition-opacity delay-0 duration-150 group-hover:opacity-100 group-hover:delay-[250ms] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#F3F4F7]">
      {label}
    </span>
  );
}

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

// Colors/spacing/active-state treatment below match the Dashboard Demo
// mockup's own .sb-item/.sb-item.active rules exactly (public/
// dashboard-demo.html) — brass/gold accent in dark mode, indigo in light
// (the demo's own light-theme swap), left-border + tinted-background active
// state instead of the old solid gradient pill, uppercase 10px section
// labels, 12.5px item text, 15px icons at constant .85 opacity. Layout
// mechanics (fixed-size icon box, label as a pure fade/no unmount, outer
// dock width as the only thing that animates) are unchanged from before —
// this is a visual reskin only, per explicit instruction ("only the
// sidebar"), not a functional rewrite. Font stays Inter app-wide (never
// font-mono) per this project's own standing rule, so the demo's Manrope/
// Space Grotesk faces were not carried over.
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
  // (stretched) parent regardless of content — `w-fit` while collapsed
  // makes the row shrink-wrap its actual visible content (icon + padding)
  // into a clean near-square instead; the label's own max-w-0 (below)
  // ensures it truly contributes zero width at that point.
  const rowClassName = cn(
    // leading-[17px] pins the row's line-box to the demo's own row height
    // target (33px = 2×8px padding + 17px line) — Inter's default line-
    // height at this font-size renders ~1.8px taller per row than the
    // demo's Manrope (measured 34.8px vs 33px), which alone accounted for
    // most of a ~19px total sidebar-height mismatch across 9 nav rows.
    'flex items-center rounded-[6px] border-l-2 px-2 py-2 text-[12.5px] font-medium leading-[17px] whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4F46E5]',
    expanded ? 'w-full' : 'w-fit',
    disabled && 'cursor-not-allowed border-l-transparent text-[#9CA3AF] dark:text-[#565C70]',
    !disabled && !active && 'border-l-transparent text-[#6B7280] hover:bg-[#F1F2F5] hover:text-[#1A1D23] dark:text-[#9198AC] dark:hover:bg-[#1A1E29] dark:hover:text-[#F3F4F7]',
    active && 'border-l-transparent font-semibold text-[#4F46E5] dark:text-[#D9A441]'
  );

  const inner = (
    <>
      <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center">
        <Icon size={15} strokeWidth={1.6} className="opacity-[0.85]" />
      </span>
      <span
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? 'ml-[10px] max-w-[170px] translate-x-0 opacity-100' : 'ml-0 max-w-0 -translate-x-1 opacity-0'
        }`}
      >
        {label}
      </span>
      {!!badge && badge > 0 && expanded && (
        <Badge className="ml-auto shrink-0 rounded-full bg-[#E23D3D] px-[5px] py-[1px] text-[9px] font-bold leading-none text-white hover:bg-[#E23D3D] dark:bg-[#F4665A] dark:hover:bg-[#F4665A]">
          {badge > 99 ? '99+' : badge}
        </Badge>
      )}
    </>
  );

  return (
    <div className="group relative my-[1px]">
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

// Uppercase, muted group label shown above each nav group while expanded —
// matches the demo's .sb-section exactly (10px/600/uppercase/.08em
// tracking, 16px/8px/6px padding). While collapsed there's no room for
// text, so a thin divider stands in as the grouping signal instead. `first`
// skips the divider/extra top spacing for the group right under the
// header, which already has its own spacing.
function NavSection({ label, expanded, first }: { label: string; expanded: boolean; first?: boolean }) {
  if (expanded) {
    return (
      <p className="px-2 pb-[6px] pt-4 text-[10px] font-semibold uppercase tracking-[0.08em] leading-[14px] text-[#9CA3AF] dark:text-[#565C70]">
        {label}
      </p>
    );
  }
  return first ? null : <div className="mx-2.5 my-1 border-t border-[#E7E9EE] dark:border-[#262B38]" />;
}

// Same destinations as before (Dashboard is the product's own root page,
// e.g. Cash Out Wallets / Send Money's equivalent; Overview is the shared,
// product-agnostic page, handled separately below), just grouped under
// section labels now instead of one flat list.
const OPERATIONS_ITEMS = [
  { href: '/agentbal', label: 'Balance', icon: IconBalance },
  { href: '/summary', label: 'Opening', icon: IconOpening },
  { href: '/stlm', label: 'Settlement', icon: IconSettlement },
  { href: '/topup', label: 'Top Up', icon: IconTopUp },
];

// Product-agnostic (shows all four ledgers — both Cashout and Send Money —
// on one page, like Dashboard itself), so this is a plain fixed href, NOT
// run through resolveHref()/ROUTE_MAP the way the per-product items above
// are — there's no Cashout vs Send Money variant to switch between.
const DAILY_ENTRY_ITEM = { href: '/daily-txn-entry', label: 'Daily Entry', icon: IconDailyEntry };

const MONITORING_ITEMS = [
  { href: '/transfer-queue', label: 'Transfer Queue', icon: IconTransferQueue, isTransferQueue: true },
  { href: '/wallet-status', label: 'Wallet Status', icon: IconWalletStatus, isTransferQueue: false },
];

// Staff/admin only — the leader-facing ticket flow (/tickets, /tickets/create)
// stays a completely separate standalone destination, not in this nav.
const SUPPORT_ITEMS = [{ href: '/staff/tickets', label: 'Tickets', icon: IconTickets }];

export default function Sidebar() {
  const pathname = usePathname();
  // /settings/demo is a sandboxed copy of the new account-menu design — the
  // rest of the app (including the real /settings) must render exactly as
  // it does in production, so this is the one place that design's Sidebar
  // changes are allowed to apply.
  const isDemoMode = pathname.startsWith('/settings/demo');
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
  // Gates the "Tickets" nav entry below — staff/admin only (leaders have
  // their own separate standalone ticket flow, never this dock).
  const [role, setRole] = useState<string | null>(null);
  const canSeeTickets = role === 'staff' || role === 'admin';

  const resolveHref = (canonicalCashoutHref: string) =>
    activeProduct === 'cashout' ? canonicalCashoutHref : getCounterpartPath(canonicalCashoutHref, 'sendmoney');

  useEffect(() => {
    setMounted(true);
    if (localStorage.getItem('sidebarPanelOpen') === 'true') setPanelOpen(true);
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRole(data?.role ?? null))
      .catch(() => setRole(null));
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
    document.documentElement.style.setProperty('--sidebar-width', panelOpen ? '216px' : '60px');
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
        className="fixed left-4 top-7 z-50 rounded-lg border border-[#E7E9EE] bg-white/90 p-2 text-[#6B7280] shadow-sm dark:border-[#262B38] dark:bg-[#12151D]/90 dark:text-[#9198AC] md:hidden"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-foreground/20 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* `fixed` + `h-full` — pinned to the viewport regardless of page
          scroll (the scrolling element is AppShell's own <main>, never this
          aside), so nav text never rides up with the page content. */}
      <aside className={`fixed left-0 top-0 z-50 flex h-full w-[250px] flex-col border-r border-[#E7E9EE] bg-white text-[#1A1D23] transition-transform duration-300 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#F3F4F7] md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-[#E7E9EE] px-4 dark:border-[#262B38]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-[#E7E9EE] dark:ring-[#262B38]">
            <BrandLogo />
          </div>
          <div className="overflow-hidden">
            <p className="whitespace-nowrap text-[13px] font-semibold leading-tight text-[#1A1D23] dark:text-[#F3F4F7]">Operations</p>
            <p className="mt-[2px] whitespace-nowrap text-[10.5px] leading-snug text-[#9CA3AF] dark:text-[#565C70]">Operations Dashboard</p>
          </div>
          <button onClick={() => setMobileOpen(false)} className="ml-auto text-[#6B7280] hover:text-[#1A1D23] dark:text-[#9198AC] dark:hover:text-[#F3F4F7]">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
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
              <NavSection label="Overview" expanded first />
              <DockRow
                href={overviewHref}
                icon={IconDashboard}
                label="Dashboard"
                active={overviewActive}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />
              <NavSection label="Operations" expanded />
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
              <DockRow
                href={DAILY_ENTRY_ITEM.href}
                icon={DAILY_ENTRY_ITEM.icon}
                label={DAILY_ENTRY_ITEM.label}
                active={pathname === DAILY_ENTRY_ITEM.href}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />

              <NavSection label="Monitoring" expanded />
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

              {canSeeTickets && (
                <>
                  <NavSection label="Support" expanded />
                  {SUPPORT_ITEMS.map((item) => (
                    <DockRow
                      key={item.href}
                      href={item.href}
                      icon={item.icon}
                      label={item.label}
                      active={pathname.startsWith(item.href)}
                      expanded
                      tooltip={false}
                      onClick={() => setMobileOpen(false)}
                    />
                  ))}
                </>
              )}

              <NavSection label="Settings" expanded />
              <DockRow
                href="/settings"
                icon={IconSettings}
                label="Settings"
                active={pathname === '/settings'}
                expanded
                tooltip={false}
                onClick={() => setMobileOpen(false)}
              />
            </>
          )}
        </div>

        {isDemoMode ? (
          // Quick-access copy for the drawer itself — pages also render
          // AccountMenu inline in their own header row (which shows on
          // mobile too), this is just a shortcut so it's reachable without
          // leaving the drawer.
          <div className="shrink-0 border-t border-[#E7E9EE] px-3 py-3 dark:border-[#262B38]">
            <AccountMenu className="w-full" />
          </div>
        ) : (
          <div className="shrink-0 border-t border-[#E7E9EE] px-3 py-3 dark:border-[#262B38]">
            <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#4F46E5] text-[11px] font-bold text-white dark:bg-[#D9A441] dark:text-[#100C02]">
                OP
              </div>
              <div className="min-w-0 overflow-hidden whitespace-nowrap">
                <p className="truncate text-[12px] font-semibold text-[#1A1D23] dark:text-[#F3F4F7]">Operations Admin</p>
                <p className="truncate text-[10px] text-[#6B7280] dark:text-[#9198AC]">admin@operations.com</p>
                <div className="mt-1 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
                  <span className="text-[9px] font-medium text-[#16A34A] dark:text-[#34D399]">Online</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* Desktop — ONE persistent container; only its width animates
          between collapsed and expanded. Icons never move: every row keeps
          the exact same fixed-size icon box (h-7 w-7) at the exact same
          left offset (px-2 on the row) in both states — only the label
          next to it fades/slides in, and only because the outer container
          is wide enough to reveal it (overflow-hidden clips it otherwise).
          Row order is fixed and identical regardless of state: brand,
          Dashboard, Overview, Balance, Opening, Settlement, Top Up,
          Transfer Queue, Wallet Status, Settings, avatar — grouped under
          Overview / Operations / Monitoring / Settings labels.
          `fixed` + `h-screen` — pinned to the viewport regardless of page
          scroll (AppShell's own <main> is the only scrolling element), so
          none of this ever rides up with the page content underneath it. */}
      <div
        className={`fixed left-0 top-0 z-[60] hidden h-screen overflow-hidden border-r border-[#E7E9EE] bg-white shadow-[1px_0_3px_rgba(0,0,0,0.04)] transition-[width] ${SIDEBAR_SYNC_DURATION_CLASS} ease-in-out dark:border-[#262B38] dark:bg-[#12151D] md:block ${
          panelOpen ? 'w-[216px]' : 'w-[60px]'
        }`}
      >
        <div className="flex h-full flex-col px-3 py-5">
          {/* Brand — plain text, no logo/icon box, matching the demo's own
              .sb-brand exactly (px-2 pb-[26px] pt-[2px] = its 2px 8px 26px
              padding). The mobile drawer keeps its own logo mark (below) —
              this is the one spot the demo genuinely has zero icon, and
              adding one back (even for the collapsed 60px state) measurably
              shifted the title 40px right of the demo's own x-position, so
              it's left out here on purpose rather than approximated. */}
          <div className="px-2 pb-[26px] pt-[2px]">
            <div className="relative flex h-8 items-center">
              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  panelOpen ? 'max-w-[170px] translate-x-0 opacity-100' : 'max-w-0 -translate-x-1 opacity-0'
                }`}
              >
                <p className="whitespace-nowrap text-[13px] font-semibold leading-tight text-[#1A1D23] dark:text-[#F3F4F7]">Operations</p>
                <p className="mt-[2px] whitespace-nowrap text-[10.5px] leading-snug text-[#9CA3AF] dark:text-[#565C70]">Operations Dashboard</p>
              </div>
            </div>
          </div>

          <NavSection label="Overview" expanded={panelOpen} first />
          <DockRow href={overviewHref} icon={IconDashboard} label="Dashboard" active={overviewActive} expanded={panelOpen} />

          {mounted && (
            <>
              <NavSection label="Operations" expanded={panelOpen} />
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
              <DockRow
                href={DAILY_ENTRY_ITEM.href}
                icon={DAILY_ENTRY_ITEM.icon}
                label={DAILY_ENTRY_ITEM.label}
                active={pathname === DAILY_ENTRY_ITEM.href}
                expanded={panelOpen}
              />

              <NavSection label="Monitoring" expanded={panelOpen} />
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

              {canSeeTickets && (
                <>
                  <NavSection label="Support" expanded={panelOpen} />
                  {SUPPORT_ITEMS.map((item) => (
                    <DockRow
                      key={item.href}
                      href={item.href}
                      icon={item.icon}
                      label={item.label}
                      active={pathname.startsWith(item.href)}
                      expanded={panelOpen}
                    />
                  ))}
                </>
              )}
            </>
          )}

          <NavSection label="Settings" expanded={panelOpen} />
          <DockRow
            href="/settings"
            icon={IconSettings}
            label="Settings"
            active={pathname === '/settings'}
            expanded={panelOpen}
          />

          {!isDemoMode && (
            <div className="relative mt-auto flex items-center gap-2 border-t border-[#E7E9EE] pb-1 pt-3 dark:border-[#262B38]">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#4F46E5] text-[10px] font-bold text-white dark:bg-[#D9A441] dark:text-[#100C02]">
                OP
              </div>
              <div
                className={`min-w-0 overflow-hidden transition-all duration-300 ease-in-out ${
                  panelOpen ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
                }`}
              >
                <p className="truncate text-[9.5px] font-semibold text-[#1A1D23] dark:text-[#F3F4F7]">Operations Admin</p>
                <p className="truncate text-[7.5px] text-[#6B7280] dark:text-[#9198AC]">admin@operations.com</p>
                <div className="mt-1 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
                  <span className="text-[7.5px] font-medium text-[#16A34A] dark:text-[#34D399]">Online</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Single floating circular toggle, rendered OUTSIDE the sidebar's
          overflow-hidden box (which would otherwise clip a button meant to
          straddle the edge) as a `fixed` sibling instead — its `left`
          position is computed from the sidebar's own current width and
          transitions in sync with the sidebar's own width animation so it
          rides along the edge smoothly. The chevron just rotates 180°
          rather than swapping icons. */}
      <button
        type="button"
        onClick={() => setPanelOpen((current) => !current)}
        aria-label={panelOpen ? 'Collapse menu' : 'Expand menu'}
        title={panelOpen ? 'Collapse menu' : 'Expand menu'}
        className={`fixed top-[19px] z-[61] hidden h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-[#E7E9EE] bg-white text-[#6B7280] shadow-[0_2px_6px_rgba(20,22,30,0.08)] transition-[left,color,background-color] ${SIDEBAR_SYNC_DURATION_CLASS} ease-in-out hover:bg-[#F1F2F5] hover:text-[#1A1D23] md:flex dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9198AC] dark:hover:bg-[#1A1E29] dark:hover:text-[#F3F4F7] ${
          panelOpen ? 'left-[206px]' : 'left-[50px]'
        }`}
      >
        <ChevronLeft size={9} className={`transition-transform duration-200 ease-in-out ${panelOpen ? '' : 'rotate-180'}`} />
      </button>
    </>
  );
}
