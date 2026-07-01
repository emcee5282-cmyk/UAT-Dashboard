'use client';

import { useState } from 'react';
import Sidebar from './Sidebar';
import PageTransition from './PageTransition';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <>
      <Sidebar isExpanded={isExpanded} onExpandedChange={setIsExpanded} />
      <main className="h-screen flex-1 overflow-y-auto md:ml-[52px]">
        <PageTransition>{children}</PageTransition>
      </main>
    </>
  );
}
