'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, Sun, Moon, ChevronDown } from 'lucide-react';
import ThemeSwitch from './ThemeSwitch';
import { useTheme } from './ThemeProvider';

// Global, persistent account control — rendered inline as the last item in
// each page's own header actions row (SettlementHeader/PageHeader/
// FloatingHeader), same row as Refresh and other icon buttons, and once
// inside the mobile drawer footer. Deliberately no pill/card container of
// its own (no border/shadow/backdrop) — it must sit flush in whatever row
// it's placed in, not read as a separately-floating element the way the
// old dedicated TopBar did. Positioning is entirely the caller's
// responsibility (via `className`).
export default function AccountMenu({ className = '' }: { className?: string }) {
  const { theme } = useTheme();
  const [username, setUsername] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUsername(data?.username ?? null))
      .catch(() => setUsername(null));
  }, []);

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

  const displayName = username ? username.charAt(0).toUpperCase() + username.slice(1) : 'Account';
  const initials = (username ?? 'AD').slice(0, 2).toUpperCase();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-8 items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-muted ${className}`}
      >
        {/* Fixed indigo, not var(--product-accent) — explicit per spec, stays
            the same regardless of active product (Cashout/Send Money). */}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ background: '#4F46E5' }}
        >
          {initials}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-[12px] font-semibold leading-tight text-foreground">{displayName}</span>
          <span className="block truncate text-[10px] leading-snug text-muted-foreground">Administrator</span>
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
          <div className="border-b border-border px-3 py-2 dark:border-[#3a3a3d]">
            <p className="truncate text-[12px] font-semibold text-foreground">{displayName}</p>
            <p className="truncate text-[10px] text-muted-foreground">Administrator</p>
            <div className="mt-1 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[9px] font-medium text-emerald-600 dark:text-emerald-400">Online</span>
            </div>
          </div>

          {/* No password-change flow exists yet (dev-only hardcoded
              credentials) — present but inert, same pattern already used
              elsewhere for not-yet-built features (e.g. the login page's
              own "Forgot password?"). */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <KeyRound size={14} />
            Change Password
          </button>

          <div className="flex items-center justify-between px-3 py-2">
            <span className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
              Theme
            </span>
            <ThemeSwitch />
          </div>

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
    </>
  );
}
