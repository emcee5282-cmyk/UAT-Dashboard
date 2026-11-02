'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { KeyRound, LogOut, ChevronDown, CircleUserRound } from 'lucide-react';
import UserAvatar from './UserAvatar';
import ProfileModal from './ProfileModal';
import { useSession } from '@/app/lib/auth/useSession';

// Global, persistent account control — rendered inline as the last item in
// each page's own header actions row (SettlementHeader/PageHeader/
// FloatingHeader), same row as Refresh and other icon buttons, and once
// inside the mobile drawer footer. Deliberately no pill/card container of
// its own (no border/shadow/backdrop) — it must sit flush in whatever row
// it's placed in, not read as a separately-floating element the way the
// old dedicated TopBar did. Positioning is entirely the caller's
// responsibility (via `className`).
export default function AccountMenu({
  className = '',
  // Opt-in, matches dashboard-demo.html's .admin-avatar/.admin-name/
  // .admin-role exactly (28px avatar, 10.5px initials/role vs the default
  // 32px/10px) — only the Dashboard page's header passes this; every other
  // AccountMenu consumer keeps its existing 32px sizing unchanged.
  compact = false,
}: { className?: string; compact?: boolean }) {
  const session = useSession();
  const username = session?.username ?? null;
  const roleLabel = session?.roleLabel ?? '';
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right, width: rect.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleLogout = async () => {
    setOpen(false);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    // Hard navigation (not next/navigation's router) — forces a real
    // request so middleware and the no-store cache header actually take
    // effect, rather than relying on the client router's own cache.
    window.location.href = '/login';
  };

  const displayName = session?.name || (username ? username.charAt(0).toUpperCase() + username.slice(1) : 'Account');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-muted ${compact ? 'h-7 gap-[9px]' : 'h-8 gap-2'} ${className}`}
      >
        {/* Photo, or initials on fixed indigo (not var(--ui-accent)) — stays
            the same regardless of active product (Cashout/Send Money). */}
        <UserAvatar user={session} size={compact ? 28 : 32} />
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-[12px] font-semibold leading-tight text-foreground">{displayName}</span>
          <span className={`block truncate leading-snug text-muted-foreground ${compact ? 'text-[10.5px]' : 'text-[10px]'}`}>{roleLabel}</span>
        </span>
        <ChevronDown size={13} className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, width: Math.max(pos.width, 220) }}
          className="z-[999] overflow-hidden rounded-xl border border-border bg-white py-1.5 shadow-xl dark:border-[#3a3a3d] dark:bg-[#1c1c1e]"
        >
          <div className="flex items-center gap-2.5 border-b border-border px-3 py-2 dark:border-[#3a3a3d]">
            <UserAvatar user={session} size={32} />
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-foreground">{displayName}</p>
              <p className="truncate text-[10px] text-muted-foreground">{roleLabel}</p>
              <div className="mt-1 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-[9px] font-medium text-emerald-600 dark:text-emerald-400">Online</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setProfileOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <CircleUserRound size={14} />
            Profile
          </button>

          <Link
            href="/change-password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <KeyRound size={14} />
            Change Password
          </Link>

          <div className="my-1 border-t border-border dark:border-[#3a3a3d]" />

          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            <LogOut size={14} />
            Logout
          </button>
        </div>,
        document.body
      )}

      {profileOpen && session && <ProfileModal session={session} onClose={() => setProfileOpen(false)} />}
    </>
  );
}
