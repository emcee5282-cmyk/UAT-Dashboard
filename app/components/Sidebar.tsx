'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, BookOpen, Wallet, ArrowLeftRight, Sparkles, Menu, X, ChevronRight, CircleDollarSign, BarChart3 } from 'lucide-react';
import { useState } from 'react';
import ThemeToggle from './ThemeToggle';

const groups = [
  {
    title: 'TRACK',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/summary', label: 'Opening Balance', icon: BookOpen },
      { href: '/agentbal', label: 'Agent Balance', icon: Wallet },
    ],
  },
  {
    title: 'SERVICES',
    items: [
      { href: '/stlm', label: 'STLM', icon: ArrowLeftRight },
      { href: '/topup', label: 'Top Up', icon: CircleDollarSign },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const NavContent = () => (
    <>
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-500/15 ring-1 ring-indigo-400/30">
            <Sparkles size={16} className="text-indigo-300" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Operations</p>
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Overview</p>
          </div>
        </div>
        <button onClick={() => setMobileOpen(false)} className="text-slate-400 hover:text-white md:hidden">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-6 px-3 py-5">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500">
              {group.title}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-medium transition-all ${
                      active
                        ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-400/20'
                        : 'text-slate-400 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon size={15} />
                      {item.label}
                    </span>
                    <ChevronRight size={14} className={active ? 'opacity-100' : 'opacity-60'} />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-white/10 px-5 py-4">
        <div className="mb-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-[11px] text-slate-400">
          <div className="mb-1 flex items-center gap-2 text-slate-200">
            <BarChart3 size={13} />
            <span>AFKenta Solution</span>
          </div>
          <p>Live operational analytics for the day.</p>
        </div>
        <ThemeToggle />
      </div>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-50 rounded-xl border border-slate-200 bg-white/90 p-2 text-slate-700 shadow md:hidden"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-950/40 md:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={`fixed left-0 top-0 z-50 flex h-full w-64 flex-col border-r border-slate-200 bg-slate-950 text-slate-200 transition-transform duration-300 md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <NavContent />
      </aside>

      <aside className="hidden h-screen w-64 shrink-0 border-r border-slate-200 bg-slate-950 text-slate-200 md:flex md:flex-col">
        <NavContent />
      </aside>
    </>
  );
}