'use client';

import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Sidebar from './Sidebar';
import PageTransition from './PageTransition';
import { getActiveProduct } from '@/app/lib/productRoutes';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeProduct = getActiveProduct(pathname, searchParams.get('product'));

  return (
    <div data-product={activeProduct} className="contents">
      <Sidebar isExpanded={isExpanded} onExpandedChange={setIsExpanded} />
      <main className="h-screen flex-1 overflow-y-auto md:ml-[52px] [scrollbar-gutter:stable]">
        <PageTransition>{children}</PageTransition>
      </main>
    </div>
  );
}
