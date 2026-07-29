'use client';

import type { ReactNode } from 'react';

function ToolbarLeft({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={className ?? 'flex flex-wrap items-center gap-3'}>{children}</div>;
}

function ToolbarCenter({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={className ?? 'flex items-center gap-3'}>{children}</div>;
}

function ToolbarRight({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={className ?? 'flex items-center gap-3 pr-2'}>{children}</div>;
}

// Generic layout-only toolbar shell — knows nothing about search, filters,
// refresh, export, or any other control. Three slots (Left/Center/Right)
// laid out with justify-between, which pins the first and last children to
// the edges regardless of what's between them — an unused Center slot
// (simply omitted by the consumer) doesn't shift Left/Right or leave a
// gap, since justify-between only ever sees the children actually
// rendered. Default height/padding/border match Settlement's own toolbar
// exactly; `className` is a full override (not merged) for pages with a
// different existing density — the design system shares layout and
// interaction patterns, not identical pixel dimensions on every page.
export default function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className ?? 'shrink-0 min-h-[56px] px-4 border-b border-[#E5E7EB] dark:border-[#3a3a3d] flex flex-wrap items-center justify-between gap-3'}>
      {children}
    </div>
  );
}

Toolbar.Left = ToolbarLeft;
Toolbar.Center = ToolbarCenter;
Toolbar.Right = ToolbarRight;
