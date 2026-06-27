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

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  {
    label: 'Agent',
    icon: Users,
    children: [
      { href: '/agentbal', label: 'Agent Balance', icon: Wallet },
      { href: '/summary', label: 'Opening Balance', icon: BookOpen },
      { href: '/stlm', label: 'STLM', icon: ArrowLeftRight },
      { href: '/topup', label: 'Top Up', icon: PlusCircle },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);

  useEffect(() => {
    setMounted(true);
  }, []);

  const NavContent = () => (
    <>
      <div className="flex items-center justify-between border-b border-[#e5e5e7] px-5 py-5 dark:border-[#3a3a3d]">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 ring-1 ring-indigo-100 dark:bg-indigo-500/15 dark:ring-indigo-400/20">
            <Sparkles size={16} className="text-indigo-500 dark:text-indigo-300" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Operations</p>
            <p className="text-[10px] text-slate-400 dark:text-[#a0a0a0]">Dashboard</p>
          </div>
        </div>
        <button onClick={() => setMobileOpen(false)} className="text-slate-400 hover:text-slate-700 dark:text-[#a0a0a0] dark:hover:text-white md:hidden">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-5">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-[#a0a0a0]">
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
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                      active
                        ? 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                    }`}
                  >
                    <Icon size={15} />
                    {item.label}
                  </Link>
                );
              }

              const ParentIcon = item.icon;
              const childActive = item.children.some((child) => pathname === child.href);

              return (
                <div key={item.label}>
                  <button
                    onClick={() => setAgentOpen((prev) => !prev)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                      childActive
                        ? 'text-slate-900 dark:text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <ParentIcon size={15} />
                      {item.label}
                    </span>
                    <ChevronDown
                      size={14}
                      className={`transition-transform ${agentOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {agentOpen && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-[#e5e5e7] pl-3 dark:border-[#3a3a3d]">
                      {item.children.map((child) => {
                        const ChildIcon = child.icon;
                        const active = pathname === child.href;
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            onClick={() => setMobileOpen(false)}
                            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                              active
                                ? 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white'
                                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a0] dark:hover:bg-white/5 dark:hover:text-white'
                            }`}
                          >
                            <ChildIcon size={14} />
                            {child.label}
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

      <div className="border-t border-[#e5e5e7] px-4 py-4 dark:border-[#3a3a3d]">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[12px] font-semibold text-slate-600 dark:bg-white/10 dark:text-white">
            OP
          </div>
          <div className="min-w-0">
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
        <NavContent />
      </aside>

      <aside className="hidden h-screen w-64 shrink-0 border-r border-[#e5e5e7] bg-white text-slate-900 dark:border-[#3a3a3d] dark:bg-[#1c1c1e] dark:text-white md:flex md:flex-col">
        <NavContent />
      </aside>
    </>
  );
}
