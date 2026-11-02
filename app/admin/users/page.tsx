'use client';

import { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Manrope } from 'next/font/google';
import { Moon, Sun } from 'lucide-react';
import PageHeader from '@/app/components/PageHeader';
import UnderlineTabs from './UnderlineTabs';
import AccountMenu from '@/app/components/AccountMenu';
import { useTheme } from '@/app/components/ThemeProvider';
import { useCan } from '@/app/lib/auth/useSession';
import UsersTab from './UsersTab';
import RolesTab from './RolesTab';

// Same font + shell as Pending Balance (app/monitoring/pending-balance/page.tsx).
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

type TabKey = 'users' | 'roles';

// Users & Roles (users.manage / roles.manage; the proxy and
// every /api/admin/* route enforce it, not this page). Layout mirrors
// Pending Balance: same width/padding, header actions, pill tabs, table chrome.
export default function UsersPage() {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canManageRoles = useCan('roles.manage');

  const tab: TabKey = searchParams.get('tab') === 'roles' && canManageRoles ? 'roles' : 'users';
  const roleFilter = searchParams.get('role') ?? undefined;
  const [refreshKey, setRefreshKey] = useState(0);
  const [spinning, setSpinning] = useState(false);

  function navigate(next: TabKey, role?: string) {
    const params = new URLSearchParams();
    if (next === 'roles') params.set('tab', 'roles');
    if (role) params.set('role', role);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function handleRefresh() {
    setSpinning(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setSpinning(false), 600);
  }

  const tabs = canManageRoles
    ? [
        { key: 'users' as const, label: 'Users' },
        { key: 'roles' as const, label: 'Roles' },
      ]
    : [{ key: 'users' as const, label: 'Users' }];

  return (
    <div className={`dd-page h-screen w-full flex flex-col overflow-hidden bg-[#F7F8FA] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#0A0C11] dark:text-white ${manrope.variable}`}>
      <style>{`
        .dd-page :where(h1, h2, h3, p, span, td, th) { line-height: normal; }
        .dd-page {
          --ink-0: #F7F8FA; --ink-1: #FFFFFF; --ink-2: #F1F2F5; --hair: #DDE0E7;
          --text-hi: #1A1D23; --text-mid: #6B7280; --text-low: #9CA3AF;
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .dark .dd-page {
          --ink-0: #0A0C11; --ink-1: #12151D; --ink-2: #1A1E29; --hair: #262B38;
          --text-hi: #F3F4F7; --text-mid: #9198AC; --text-low: #565C70;
        }
        main:has(.dd-page) { background: #F7F8FA; }
        .dark main:has(.dd-page) { background: #0A0C11; }
      `}</style>
      <main className="flex flex-1 flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col min-h-0 pt-4">
          <PageHeader
            title="Users & Roles"
            containerless
            stickyOffset={16}
            actions={
              <>
                <button
                  onClick={handleRefresh}
                  disabled={spinning}
                  aria-label="Refresh"
                  title="Refresh"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] disabled:opacity-50 dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" className={spinning ? 'animate-spin' : ''} style={{ color: spinning ? 'var(--ui-accent)' : undefined }}>
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={toggleTheme}
                  aria-label="Toggle light and dark mode"
                  title="Toggle light and dark mode"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
                </button>
                <AccountMenu compact />
              </>
            }
          />

          {tab === 'users' ? (
            // Users tab puts Export / Add user on the switcher's row, so it
            // renders the switcher itself (same -7px pull-up as below).
            <div className="-mt-[7px] flex min-h-0 flex-1 flex-col">
              <UsersTab
                key={roleFilter ?? ''}
                refreshKey={refreshKey}
                initialRole={roleFilter}
                tabs={<UnderlineTabs tabs={tabs} active={tab} onSelect={(k) => navigate(k)} />}
              />
            </div>
          ) : (
            <>
              {/* Same -7px pull-up as Pending Balance (see the comment there). */}
              <div className="-mt-[7px]">
                <UnderlineTabs tabs={tabs} active={tab} onSelect={(k) => navigate(k)} />
              </div>
              <RolesTab refreshKey={refreshKey} onShowUsers={(roleKey) => navigate('users', roleKey)} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
