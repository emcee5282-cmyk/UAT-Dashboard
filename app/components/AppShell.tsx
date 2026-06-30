'use client';

import { useState } from 'react';
import Sidebar from './Sidebar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <>
      <Sidebar isExpanded={isExpanded} onExpandedChange={setIsExpanded} />
      <main
        className={`h-screen flex-1 overflow-y-auto transition-[margin-left] duration-300 ${
          isExpanded ? 'md:ml-64' : 'md:ml-16'
        }`}
      >
        {children}
      </main>
    </>
  );
}
