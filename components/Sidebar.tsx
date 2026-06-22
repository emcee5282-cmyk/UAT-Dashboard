'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, ChevronDown, BookOpen, Zap } from 'lucide-react';
import { useState } from 'react';

export default function Sidebar() {
  const pathname = usePathname();
  const [summaryOpen, setSummaryOpen] = useState(true);

  return (
    <aside className="w-56 min-h-screen bg-[#0d1117] border-r border-white/[0.06] flex flex-col sticky top-0 h-screen overflow-y-auto">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/[0.06] flex items-center gap-3">
        <div className="relative w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
          <Zap size={14} className="text-indigo-400" />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        <div>
          <p className="font-bold text-sm text-white leading-none">Operations</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Overview</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">

        {/* Dashboard */}
        <Link
          href="/"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
            pathname === '/'
              ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
              : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
          }`}
        >
          <LayoutDashboard size={15} />
          Dashboard
        </Link>

        {/* Summary dropdown */}
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
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  pathname === '/summary'
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                <BookOpen size={13} />
                Opening Balance
              </Link>
            </div>
          )}
        </div>

      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-white/[0.06]">
        <p className="text-[10px] text-slate-700 tracking-wide">Powered by AFKenta Solution ®</p>
      </div>
    </aside>
  );
}