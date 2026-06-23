'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, ChevronDown, BookOpen, Wallet, Zap, Menu, X, ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';

export default function Sidebar() {
  const pathname = usePathname();
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  const NavContent = () => (
    <>
      <div className="px-5 py-5 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
            <Zap size={14} className="text-indigo-400" />
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div>
            <p className="font-bold text-sm text-white leading-none">Operations</p>
            <p className="text-[10px] text-slate-500 mt-0.5">Overview</p>
          </div>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden text-slate-500 hover:text-slate-200"
        >
          <X size={16} />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        <Link
          href="/"
          onClick={() => setMobileOpen(false)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
            pathname === '/'
              ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
              : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
          }`}
        >
          <LayoutDashboard size={15} />
          Dashboard
        </Link>

        <div>
          <button
            onClick={() => setSummaryOpen(!summaryOpen)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-all"
          >
            <div className="flex items-center gap-3">
              <Users size={15} />
              Summary
            </div>
            <ChevronDown
              size={13}
              className={`transition-transform duration-200 ${summaryOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {summaryOpen && (
            <div className="mt-1 ml-4 pl-3 border-l border-white/[0.06] space-y-1">
              <Link
                href="/summary"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  pathname === '/summary'
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                <BookOpen size={13} />
                Opening Balance
              </Link>
              <Link
                href="/agentbal"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  pathname === '/agentbal'
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                <Wallet size={13} />
                Agent Balance
              </Link>
              <Link
                href="/stlm"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  pathname === '/stlm'
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                <ArrowLeftRight size={13} />
                STLM & Top Up
              </Link>
            </div>
          )}
        </div>
      </nav>

      <div className="px-5 py-4 border-t border-white/[0.06]">
        <p className="text-[10px] text-slate-700 tracking-wide">Powered by AFKenta Solution ®</p>
      </div>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3.5 left-4 z-50 text-slate-400 hover:text-slate-200 bg-[#0d1117] border border-white/[0.06] rounded-lg p-2"
      >
        <Menu size={16} />
      </button>

      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={`md:hidden fixed top-0 left-0 h-full w-56 bg-[#0d1117] border-r border-white/[0.06] flex flex-col z-50 transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <NavContent />
      </aside>

      <aside className="hidden md:flex w-56 h-screen bg-[#0d1117] border-r border-white/[0.06] flex-col sticky top-0">
        <NavContent />
      </aside>
    </>
  );
}