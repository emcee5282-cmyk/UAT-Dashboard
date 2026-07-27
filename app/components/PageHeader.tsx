'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FLOATING_HEADER_SHELL_CLASS } from '../design-system/shadows';

type PageHeaderProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  // Optional centered content (e.g. a product switcher) — rendered inline
  // on desktop (md+) and as a wrapped row below the main header on mobile,
  // matching how the old FloatingHeader handled tabs. Generic on purpose:
  // this component doesn't know or care what's inside it.
  centerSlot?: ReactNode;
  actions?: ReactNode;
};

// Page-identity header only — icon, title, optional description, optional
// centered content, optional right-side actions. Deliberately doesn't know
// about search/filters/export/refresh/column-controls; those are Toolbar
// concerns that belong to the page itself. Extracted from FloatingHeader
// (Settlement is the reference/first consumer) — visual shell (sticky
// pill, h-14 row, icon/title styling) is unchanged from that component so
// switching to this one is not a redesign.
export default function PageHeader({ icon: Icon, title, description, centerSlot, actions }: PageHeaderProps) {
  return (
    <div className="sticky top-4 z-30 mx-4 md:mx-8">
      <header className={FLOATING_HEADER_SHELL_CLASS}>
        <div className="flex h-14 items-center justify-between gap-2 pl-14 pr-4 md:grid md:grid-cols-3 md:pl-5 md:pr-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white"
              style={{ background: 'var(--product-accent)' }}
            >
              <Icon size={14} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                {title}
              </h1>
              {description && (
                <p className="truncate text-[11px] leading-snug text-muted-foreground">{description}</p>
              )}
            </div>
          </div>

          <div className="hidden md:flex md:justify-center">{centerSlot}</div>

          <div className="flex shrink-0 items-center justify-end gap-2">{actions}</div>
        </div>

        {/* Mobile-only — same centerSlot content, full header width so it
            has room to breathe instead of being squeezed into the 3-column
            grid above. */}
        {centerSlot && (
          <div className="flex items-center justify-center gap-7 border-t border-border py-2 md:hidden">
            {centerSlot}
          </div>
        )}
      </header>
    </div>
  );
}
