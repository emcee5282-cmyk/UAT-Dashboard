'use client';

import { ShieldOff, LogOut } from 'lucide-react';

// Landing page for a signed-in account whose role has no pages at all
// (e.g. the scheduler's 'system' service account) — see homePathFor in
// app/lib/auth/permissions.ts.
export default function NoAccessPage() {
  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#f4f6fb] px-4 font-[Inter,sans-serif] dark:bg-[#020617]">
      <div className="w-full max-w-[400px] rounded-2xl border border-border bg-white p-8 text-center shadow-[0_10px_40px_rgba(15,23,42,0.08)] dark:bg-[#0d1117]">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ShieldOff size={24} />
        </span>
        <h1 className="text-[20px] font-bold text-foreground">No access</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">This account has no dashboard pages. Contact your administrator.</p>
        <button
          type="button"
          onClick={handleLogout}
          className="mx-auto mt-6 flex items-center gap-1.5 text-[12.5px] font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400"
        >
          <LogOut size={14} />
          Logout
        </button>
      </div>
    </div>
  );
}
