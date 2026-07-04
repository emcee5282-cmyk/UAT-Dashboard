'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getActiveProduct, getCounterpartPath } from '@/app/lib/productRoutes';
import {
  LayoutDashboard,
  Users,
  Wallet,
  BookOpen,
  ArrowLeftRight,
  PlusCircle,
  ChevronDown,
  Menu,
  X,
  Shuffle,
  Settings,
} from 'lucide-react';

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
    {/* Dark ring so dot lifts off the white bar */}
    <circle cx="20" cy="4" r="2" fill="#0c1020" />
    {/* Emerald dot */}
    <circle cx="20" cy="4" r="1.4" fill="#10b981" />
  </svg>
);
import { useEffect, useState } from 'react';
import { fetchTransferQueueCount } from '@/app/lib/transferQueueCount';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  {
    label: 'Agent',
    icon: Users,
    children: [
      { href: '/agentbal', label: 'Balances', icon: Wallet },
      { href: '/summary', label: 'Opening', icon: BookOpen },
      { href: '/stlm', label: 'Settlement', icon: ArrowLeftRight },
      { href: '/topup', label: 'Top Up', icon: PlusCircle },
      { href: '/transfer-queue', label: 'Transfer Queue', icon: Shuffle },
    ],
  },
];

type SidebarProps = {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

export default function Sidebar({ isExpanded, onExpandedChange }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // URL is the single source of truth for the active product — never client state.
  const activeProduct = getActiveProduct(pathname);
  const [transferQueueCount, setTransferQueueCount] = useState<number | null>(null);

  const goToProduct = (target: 'cashout' | 'sendmoney') => {
    router.push(getCounterpartPath(pathname, target));
  };

  const resolveHref = (canonicalCashoutHref: string) =>
    activeProduct === 'cashout' ? canonicalCashoutHref : getCounterpartPath(canonicalCashoutHref, 'sendmoney');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const load = () => {
      fetchTransferQueueCount()
        .then(setTransferQueueCount)
        .catch(() => setTransferQueueCount(null));
    };

    load();
    const interval = setInterval(load, 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const isMockup = pathname.startsWith('/mockup');
  const displayCount = isMockup ? 150 : transferQueueCount;

  const NavContent = ({ expanded }: { expanded: boolean }) => (
    <>
      {/* Brand */}
      <div className={`flex h-14 shrink-0 items-center border-b border-border ${expanded ? 'gap-3 px-4' : 'justify-center'}`}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0c1020] ring-1 ring-white/10">
          <GeoLogo />
        </div>
        <div className={`overflow-hidden transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
          <p className="whitespace-nowrap text-[13px] font-semibold leading-tight text-foreground">Operations</p>
          <p className="whitespace-nowrap text-[8px] leading-snug text-muted-foreground/70">Real-time Operational Dashboard</p>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="ml-auto text-muted-foreground hover:text-foreground md:hidden"
        >
          <X size={15} />
        </button>
      </div>

      {/* Nav */}
      <div className="flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-2 py-3">
        {!mounted ? (
          <div className="space-y-1.5 px-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-8 rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {/* Smart Solution — product-scoped nav */}
            <div
              data-product={activeProduct}
              className={`rounded-xl border border-[color:var(--product-accent)]/40 transition-colors duration-200 ${expanded ? 'p-2' : 'p-1'}`}
            >
              {expanded && (
                <>
                  <p className="whitespace-nowrap px-1 pb-1.5 pt-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Smart Solution
                  </p>
                  <div className="mb-2 flex rounded-lg bg-muted/60 p-0.5">
                    <button
                      type="button"
                      aria-pressed={activeProduct === 'cashout'}
                      onClick={() => goToProduct('cashout')}
                      className={`flex-1 whitespace-nowrap rounded-md px-2 py-1 text-[10.5px] font-semibold transition-colors ${
                        activeProduct === 'cashout'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Cashout
                    </button>
                    <button
                      type="button"
                      aria-pressed={activeProduct === 'sendmoney'}
                      onClick={() => goToProduct('sendmoney')}
                      className={`flex-1 whitespace-nowrap rounded-md px-2 py-1 text-[10.5px] font-semibold transition-colors ${
                        activeProduct === 'sendmoney'
                          ? 'bg-teal-600 text-white shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Send Money
                    </button>
                  </div>
                </>
              )}

              {/* Collapsed rail: minimum viable switcher — the dot itself is clickable.
                  TODO: a proper flyout/expand-on-tap picker would be nicer once there
                  are more than two products; deferring that, not the interaction. */}
              {!expanded && (
                <div className="mb-1.5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => goToProduct(activeProduct === 'cashout' ? 'sendmoney' : 'cashout')}
                    title={activeProduct === 'cashout' ? 'Switch to Send Money' : 'Switch to Cashout'}
                    aria-label={activeProduct === 'cashout' ? 'Switch to Send Money' : 'Switch to Cashout'}
                    className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--product-accent-active-bg)]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--product-accent)]" />
                  </button>
                </div>
              )}

              <div className="space-y-0.5">
                {navItems.map((item) => {
                  if (!item.children) {
                    const Icon = item.icon;
                    const targetHref = resolveHref(item.href);
                    const active = pathname === targetHref;
                    return (
                      <Link
                        key={item.href}
                        href={targetHref}
                        onClick={() => setMobileOpen(false)}
                        title={expanded ? undefined : item.label}
                        className={`flex w-full items-center rounded-lg px-3 py-2 text-[12px] font-medium transition-all duration-150 ${
                          expanded ? 'gap-3' : 'justify-center gap-0 px-0'
                        } ${
                          active
                            ? 'bg-[color:var(--product-accent-active-bg)] text-[color:var(--product-accent)]'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        <Icon size={15} strokeWidth={1.75} className="shrink-0" />
                        <span className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
                          {item.label}
                        </span>
                      </Link>
                    );
                  }

                  const ParentIcon = item.icon;
                  const childActive = item.children.some((child) => pathname === resolveHref(child.href));

                  return (
                    <div key={item.label}>
                      <button
                        onClick={() => setAgentOpen((prev) => !prev)}
                        title={expanded ? undefined : item.label}
                        className={`group flex w-full items-center rounded-lg px-3 py-2 text-[12px] font-medium transition-all duration-150 ${
                          expanded ? 'justify-between gap-3' : 'justify-center gap-0 px-0'
                        } ${
                          childActive
                            ? 'text-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        <span className={`flex items-center ${expanded ? 'gap-3' : 'justify-center gap-0'}`}>
                          <span className="relative shrink-0">
                            <ParentIcon size={15} strokeWidth={1.75} />
                            {activeProduct === 'cashout' && !expanded && !!displayCount && displayCount > 0 && (
                              <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-[12px] items-center justify-center rounded-full bg-[color:var(--product-accent)] px-0.5 text-[7px] font-bold leading-none text-white">
                                {displayCount > 99 ? '99+' : displayCount}
                              </span>
                            )}
                          </span>
                          <span className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
                            {item.label}
                          </span>
                          {activeProduct === 'cashout' && expanded && !!displayCount && displayCount > 0 && (
                            <span className="flex h-4 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[color:var(--product-accent)] px-1.5 text-[9px] font-bold leading-none text-white">
                              {displayCount > 999 ? '999+' : displayCount}
                            </span>
                          )}
                        </span>
                        {expanded && (
                          <ChevronDown
                            size={13}
                            strokeWidth={1.75}
                            className={`shrink-0 transition-all duration-200 ease-in-out group-hover:text-foreground ${
                              agentOpen ? 'rotate-180 text-foreground' : 'text-muted-foreground'
                            }`}
                          />
                        )}
                      </button>

                      {/* Animated children — precise max-h + staggered item entrance */}
                      <div className={`overflow-hidden transition-all duration-250 ease-in-out ${
                        expanded && agentOpen ? 'max-h-[220px] opacity-100' : 'max-h-0 opacity-0'
                      }`}>
                        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border pb-0.5 pl-3">
                          {item.children.map((child, idx) => {
                            const ChildIcon = child.icon;
                            const targetHref = resolveHref(child.href);
                            const active = pathname === targetHref;
                            const isTransferQueue = child.href === '/transfer-queue';
                            return (
                              <Link
                                key={child.href}
                                href={targetHref}
                                onClick={() => setMobileOpen(false)}
                                style={
                                  expanded && agentOpen
                                    ? { animation: `navItemIn 180ms ease-out ${idx * 35}ms both` }
                                    : undefined
                                }
                                className={`flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[11px] font-medium transition-all duration-150 ${
                                  active
                                    ? 'bg-[color:var(--product-accent-active-bg)] text-[color:var(--product-accent)]'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                }`}
                              >
                                <span className="flex items-center gap-2.5">
                                  <ChildIcon size={13} strokeWidth={1.75} className="shrink-0" />
                                  {child.label}
                                </span>
                                {activeProduct === 'cashout' && isTransferQueue && !!displayCount && displayCount > 0 && (
                                  <span
                                    title={`${displayCount} agent${displayCount === 1 ? '' : 's'} need transfer`}
                                    className="flex h-4 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[color:var(--product-accent)] px-1.5 text-[9px] font-bold leading-none text-white"
                                  >
                                    {displayCount > 999 ? '999+' : displayCount}
                                  </span>
                                )}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* General — placeholder for future non-product pages */}
            {expanded && (
              <div>
                <p className="whitespace-nowrap px-3 pb-1 pt-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/50">
                  General
                </p>
                <div
                  title="Coming soon"
                  className="flex w-full cursor-not-allowed items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-[12px] font-medium text-muted-foreground/50"
                >
                  <span className="flex items-center gap-3 whitespace-nowrap">
                    <Settings size={15} strokeWidth={1.75} className="shrink-0" />
                    Settings
                  </span>
                  <span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[8px] font-semibold text-muted-foreground/70">
                    Soon
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className={`shrink-0 border-t border-border py-3 ${expanded ? 'px-3' : 'px-2'}`}>
        <div className={`flex items-center gap-3 rounded-lg py-1.5 ${expanded ? 'px-2' : 'justify-center'}`}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
            OP
          </div>
          <div className={`min-w-0 overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
            <p className="truncate text-[12px] font-semibold text-foreground">Operations Admin</p>
            <p className="truncate text-[10px] text-muted-foreground">admin@operations.com</p>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-2 z-50 rounded-lg border border-border bg-white/90 p-2 text-muted-foreground shadow-sm dark:bg-[#0d1117]/90 md:hidden"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-foreground/20 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`fixed left-0 top-0 z-50 flex h-full w-60 flex-col border-r border-border bg-white text-foreground transition-transform duration-300 dark:bg-[#0d1117] md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <NavContent expanded />
      </aside>

      <aside
        onMouseEnter={() => onExpandedChange(true)}
        onMouseLeave={() => onExpandedChange(false)}
        className={`fixed left-0 top-0 z-[60] hidden h-screen flex-col overflow-hidden border-r border-border bg-white text-foreground transition-[width] duration-300 dark:bg-[#0d1117] md:flex ${
          isExpanded ? 'w-60 shadow-lg' : 'w-[52px]'
        }`}
      >
        <NavContent expanded={isExpanded} />
      </aside>
    </>
  );
}
