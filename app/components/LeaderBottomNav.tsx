'use client';

// Bottom navigation for the leader app (Tracker): the /tickets list (the
// login landing page) and the /leader pages. Only rendered for accounts
// that raise tickets — an Admin opening /tickets via tickets.leaderView
// sees the page exactly as before, with no nav.
//
// Also registers the PWA service worker (public/sw.js), since every
// installable leader screen renders this component.
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardList, LayoutList, MessageSquare, PlusCircle } from 'lucide-react';
import { useCan } from '@/app/lib/auth/useSession';

const TABS = [
  { href: '/tickets', label: 'Tickets', Icon: MessageSquare, match: (p: string) => p === '/tickets' },
  { href: '/leader/balance', label: 'Balance', Icon: LayoutList, match: (p: string) => p.startsWith('/leader/balance') },
  { href: '/leader/request', label: 'Request', Icon: PlusCircle, match: (p: string) => p.startsWith('/leader/request') && !p.startsWith('/leader/requests') },
  { href: '/leader/requests', label: 'My Requests', Icon: ClipboardList, match: (p: string) => p.startsWith('/leader/requests') },
];

// Space the page must leave at the bottom so the fixed bar never covers content.
export const LEADER_NAV_PADDING = 'pb-[calc(5rem+env(safe-area-inset-bottom))]';

export default function LeaderBottomNav() {
  const pathname = usePathname();
  const canRaise = useCan('tickets.raise');

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);

  if (!canRaise) return null;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto grid max-w-2xl grid-cols-4">
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)] ${
                  active ? 'text-[color:var(--ui-accent)]' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={22} strokeWidth={active ? 2.4 : 2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
