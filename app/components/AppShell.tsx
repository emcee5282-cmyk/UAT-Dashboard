'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Sidebar from './Sidebar';
import PageTransition from './PageTransition';
import { getActiveProduct } from '@/app/lib/productRoutes';
import { SIDEBAR_SYNC_DURATION_CLASS } from '@/app/design-system/transitions';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeProduct = getActiveProduct(pathname, searchParams.get('product'));

  // Login is a standalone full-page layout — no sidebar/dock, no product
  // theming. Kept as a pathname check here (rather than a route group)
  // since every other route already flows through this one AppShell.
  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <div data-product={activeProduct} className="contents">
      <Sidebar />
      {/* Sidebar is `fixed` (out of flow), so this margin is what actually
          reserves its space — kept in sync with Sidebar's own panelOpen
          state via the --sidebar-width CSS variable it sets (see
          Sidebar.tsx), rather than a static value that only matched the
          collapsed width. flex-1 + min-w-0 let this stretch to fill
          whatever's left of the viewport instead of assuming a fixed
          desktop content width. No top offset — there's no separate
          floating header band anymore, the account menu now lives inline
          in each page's own header row (SettlementHeader/PageHeader/
          FloatingHeader). */}
      <main className={`h-screen min-w-0 flex-1 overflow-y-auto transition-[margin-left] ${SIDEBAR_SYNC_DURATION_CLASS} ease-in-out [scrollbar-gutter:stable] md:ml-[var(--sidebar-width)]`}>
        <PageTransition>{children}</PageTransition>
      </main>
    </div>
  );
}
