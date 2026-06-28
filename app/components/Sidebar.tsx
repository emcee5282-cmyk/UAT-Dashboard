'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  Sparkles,
} from 'lucide-react';
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
      { href: '/transfer-queue', label: 'Transfer Queue', icon: ArrowLeftRight },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [transferQueueCount, setTransferQueueCount] = useState<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    fetchTransferQueueCount()
      .then(setTransferQueueCount)
      .catch(() => setTransferQueueCount(null));
  }, []);

  const isMockup = pathname.startsWith('/mockup');
  const displayCount = isMockup ? 150 : transferQueueCount;

  const NavContent = ({ expanded }: { expanded: boolean }) => (
    <>
      <div className={`flex items-center border-b border-[#e5e5e7] py-5 dark:border-[#3a3a3d] ${expanded ? 'justify-between px-5' : 'justify-center px-2'}`}>
        <div className={`flex items-center gap-3 ${expanded ? '' : 'justify-center'}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 ring-1 ring-indigo-100 dark:bg-indigo-500/15 dark:ring-indigo-400/20">
            <Sparkles size={16} className="text-indigo-500 dark:text-indigo-300" />
          </div>
          <div className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Operations</p>
            <p className="text-[10px] text-slate-400 dark:text-[#a0a0a0]">Dashboard</p>
          </div>
        </div>
        <button onClick={() => setMobileOpen(false)} className="text-slate-400 hover:text-slate-700 dark:text-[#a0a0a0] dark:hover:text-white md:hidden">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-3 py-5">
        <p
          className={`mb-2 overflow-hidden whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 transition-all duration-300 dark:text-[#a0a0a0] ${
            expanded ? 'px-3 opacity-100' : 'px-0 opacity-0'
          }`}
        >
          Main Navigation
        </p>

        {!mounted ? (
          <div className="space-y-2 px-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-4 w-3/4 rounded-md" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {navItems.map((item) => {
              if (!item.children) {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href!}
                    onClick={() => setMobileOpen(false)}
                    title={expanded ? undefined : item.label}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${expanded ? '' : 'justify-center px-0'} ${
                      active
                        ? 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                    }`}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
                      {item.label}
                    </span>
                  </Link>
                );
              }

              const ParentIcon = item.icon;
              const childActive = item.children.some((child) => pathname === child.href);

              return (
                <div key={item.label}>
                  <button
                    onClick={() => setAgentOpen((prev) => !prev)}
                    title={expanded ? undefined : item.label}
                    className={`flex w-full items-center rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${expanded ? 'justify-between' : 'justify-center px-0'} ${
                      childActive
                        ? 'text-slate-900 dark:text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                    }`}
                  >
                    <span className={`flex items-center gap-3 ${expanded ? '' : 'justify-center'}`}>
                      <span className="relative shrink-0">
                        <ParentIcon size={15} className="shrink-0" />
                        {!expanded && !!displayCount && displayCount > 0 && (
                          <span className="absolute -right-1.5 -top-1.5 flex h-3 min-w-[12px] items-center justify-center rounded-full bg-slate-200 px-0.5 text-[7px] font-semibold leading-none text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                            {displayCount > 99 ? '99+' : displayCount}
                          </span>
                        )}
                      </span>
                      <span className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
                        {item.label}
                      </span>
                      {expanded && !!displayCount && displayCount > 0 && (
                        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-slate-200 px-1 text-[10px] font-semibold leading-none text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                          {displayCount > 99 ? '99+' : displayCount}
                        </span>
                      )}
                    </span>
                    {expanded && (
                      <ChevronDown
                        size={14}
                        className={`shrink-0 transition-transform ${agentOpen ? 'rotate-180' : ''}`}
                      />
                    )}
                  </button>

                  {expanded && agentOpen && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-[#e5e5e7] pl-3 dark:border-[#3a3a3d]">
                      {item.children.map((child) => {
                        const ChildIcon = child.icon;
                        const active = pathname === child.href;
                        const isTransferQueue = child.href === '/transfer-queue';
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            onClick={() => setMobileOpen(false)}
                            className={`flex items-center justify-between gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                              active
                                ? 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white'
                                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                            }`}
                          >
                            <span className="flex items-center gap-2.5">
                              <ChildIcon size={14} className="shrink-0" />
                              {child.label}
                            </span>
                            {isTransferQueue && !!displayCount && displayCount > 0 && (
                              <span
                                title={`${displayCount} agent${displayCount === 1 ? '' : 's'} need transfer`}
                                className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-slate-200 px-1 text-[10px] font-semibold leading-none text-slate-700 dark:bg-slate-700 dark:text-slate-300"
                              >
                                {displayCount > 99 ? '99+' : displayCount}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={`border-t border-[#e5e5e7] py-4 dark:border-[#3a3a3d] ${expanded ? 'px-4' : 'px-2'}`}>
        <div className={`flex items-center gap-3 rounded-xl py-2 ${expanded ? 'px-2' : 'justify-center px-0'}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[12px] font-semibold text-slate-600 dark:bg-white/10 dark:text-white">
            OP
          </div>
          <div className={`min-w-0 overflow-hidden whitespace-nowrap transition-all duration-300 ${expanded ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
            <p className="truncate text-[13px] font-medium text-slate-900 dark:text-white">Operations Admin</p>
            <p className="truncate text-[11px] text-slate-400 dark:text-[#a0a0a0]">admin@operations.com</p>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-50 rounded-xl border border-[#e5e5e7] bg-white/90 p-2 text-[#6b7280] shadow md:hidden"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && <div className="fixed inset-0 z-40 bg-[#1c1c1e]/40 md:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={`fixed left-0 top-0 z-50 flex h-full w-64 flex-col bg-white text-slate-900 transition-transform duration-300 dark:bg-[#1c1c1e] dark:text-white md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <NavContent expanded />
      </aside>

      <aside
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => setIsExpanded(false)}
        className={`fixed left-0 top-0 z-[60] hidden h-screen flex-col overflow-hidden border-r border-[#e5e5e7] bg-white text-slate-900 transition-all duration-300 dark:border-[#3a3a3d] dark:bg-[#1c1c1e] dark:text-white md:flex ${
          isExpanded ? 'w-64 shadow-xl' : 'w-16'
        }`}
      >
        <NavContent expanded={isExpanded} />
      </aside>
    </>
  );
}
