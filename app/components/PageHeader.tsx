'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FLOATING_HEADER_SHELL_CLASS } from '../design-system/shadows';
import HeaderFadeEdge from './HeaderFadeEdge';

type PageHeaderProps = {
  // Optional — pages that want a clean, text-only title (e.g. Balance
  // Overview) simply omit it and no icon badge renders at all.
  icon?: LucideIcon;
  title: string;
  description?: string;
  // Optional centered content (e.g. a product switcher) — rendered inline
  // on desktop (md+) and as a wrapped row below the main header on mobile,
  // matching how the old FloatingHeader handled tabs. Generic on purpose:
  // this component doesn't know or care what's inside it.
  centerSlot?: ReactNode;
  actions?: ReactNode;
  // Opt-in per page. When true, renders flush against the page background
  // instead of the floating rounded/bordered/shadowed pill — no card, no
  // border, no margin, fixed 64px height, edge-to-edge. Permanently solid,
  // hardcoded to the exact same legacy page-bg pair every containerless
  // consumer wraps itself in (bg-[#f5f5f7] dark:bg-[#1c1c1e] — NOT the
  // --background token, which is a different design-system-v2 color and
  // visibly mismatches, reading as a highlighted/separated band). The
  // header itself never fades/blurs/changes opacity on scroll, per
  // explicit spec ("header is a fixed mask, it never fades"). The illusion
  // of content passing "underneath" it instead comes from HeaderFadeEdge,
  // a static gradient on the content side of that boundary, color-matched
  // to the same pair. Default (false) keeps every existing consumer
  // unchanged.
  containerless?: boolean;
};

// Page-identity header only — icon, title, optional description, optional
// centered content, optional right-side actions. Deliberately doesn't know
// about search/filters/export/refresh/column-controls; those are Toolbar
// concerns that belong to the page itself. Extracted from FloatingHeader
// (Settlement is the reference/first consumer) — visual shell (sticky
// pill, h-14 row, icon/title styling) is unchanged from that component so
// switching to this one is not a redesign.
export default function PageHeader({ icon: Icon, title, description, centerSlot, actions, containerless = false }: PageHeaderProps) {
  return (
    <div className={containerless ? 'sticky top-0 z-30 w-full' : 'sticky top-4 z-30 mx-4 md:mx-8'}>
      <header className={containerless ? 'bg-[#f5f5f7] dark:bg-[#1c1c1e]' : FLOATING_HEADER_SHELL_CLASS}>
        <div className={`flex items-center justify-between gap-2 pl-14 pr-4 md:grid md:grid-cols-3 md:pl-5 md:pr-5 ${containerless ? 'h-16' : 'h-14'}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && (
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white"
                style={{ background: 'var(--product-accent)' }}
              >
                <Icon size={14} />
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                {title}
              </h1>
              {description && (
                <p className="mt-1 truncate text-[11px] font-normal leading-snug text-muted-foreground">{description}</p>
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
      {containerless && <HeaderFadeEdge bgClassName="from-[#f5f5f7] dark:from-[#1c1c1e]" />}
    </div>
  );
}
