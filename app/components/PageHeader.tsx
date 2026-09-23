'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FLOATING_HEADER_SHELL_CLASS } from '../design-system/shadows';

type PageHeaderProps = {
  // Optional — pages that want a clean, text-only title (e.g. Balance
  // Overview) simply omit it and no icon badge renders at all. Not used by
  // the containerless variant (see below) — no consumer needs it there.
  icon?: LucideIcon;
  title: string;
  description?: string;
  // Optional centered content (e.g. a product switcher) — rendered inline
  // on desktop (md+) and as a wrapped row below the main header on mobile,
  // matching how the old FloatingHeader handled tabs. Generic on purpose:
  // this component doesn't know or care what's inside it. Not used by the
  // containerless variant today (no consumer needs it there), but still
  // rendered if passed.
  centerSlot?: ReactNode;
  actions?: ReactNode;
  // Opt-in per page. When true, renders as a sticky title row — no card, no
  // border-radius, no margin, solid background, bottom border — matching
  // dashboard-demo.html's own .page-title-row exactly. Pinned to the top of
  // the scrolling container while page content scrolls underneath.
  //
  // IMPORTANT — this is why it returns a completely different, unwrapped
  // JSX tree instead of branching inside the normal-header structure below:
  // position:sticky only has "room" to stay pinned for as long as its own
  // DIRECT PARENT box hasn't itself scrolled past the sticky point — once
  // the parent's bottom edge passes top:0, the child has nowhere left to
  // stick and scrolls away with it. A parent that's exactly as tall as the
  // sticky row itself (e.g. a max-w wrapper containing nothing else) gives
  // it zero room — it stops sticking almost immediately. The demo avoids
  // this because .page-title-row shares the *same* .wrap as the entire
  // rest of the page's content, so that parent is page-height tall. The
  // containerless caller (app/page.tsx) MUST render this as the first
  // child inside its own <main>'s mx-auto max-w-[1400px] wrapper — the
  // same one the body content lives in — not as a sibling with its own
  // separate wrapper, or the sticky behavior silently breaks the moment
  // you scroll past the header's own height (confirmed via getBoundingClientRect
  // during implementation: top stayed correct only when nested this way).
  containerless?: boolean;
  // Containerless only — px offset the sticky bar settles at once scrolled,
  // instead of flush top:0. Defaults to unset (existing top-0 behavior,
  // unchanged for every current consumer) — a caller that also adds real
  // layout space above this component (e.g. padding-top on the parent it's
  // nested in, per the containerless nesting rule above) should pass that
  // same px value here, or the gap collapses back to zero the moment the
  // bar actually starts sticking.
  stickyOffset?: number;
};

function ContainerlessHeader({ title, description, centerSlot, actions, stickyOffset }: PageHeaderProps) {
  return (
    <div
      className="sticky top-0 z-20 mb-[22px] flex flex-col items-start gap-2 border-b pb-[14px] pt-14 md:flex-row md:items-end md:justify-between md:pt-[14px]"
      style={{
        background: 'var(--ink-0)',
        borderColor: 'var(--hair)',
        top: stickyOffset,
        // A non-zero stickyOffset pins this element's own top edge below
        // the true viewport top (e.g. 16px), but leaves that strip above it
        // uncovered — nothing else paints there, so whatever content has
        // scrolled up to that exact position (this header sits in normal
        // flow, so anything after it in the DOM passes behind it once
        // stuck) shows through in that gap. A solid, unblurred box-shadow
        // offset upward by the same amount extends this element's own
        // opaque background into that strip without affecting layout.
        boxShadow: stickyOffset ? `0 -${stickyOffset}px 0 0 var(--ink-0)` : undefined,
      }}
    >
      <div className="w-full min-w-0 md:w-auto">
        <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground">{title}</h1>
        {description && <p className="mt-1 truncate text-[11px] font-normal leading-snug text-muted-foreground">{description}</p>}
      </div>
      {centerSlot && <div className="w-full md:w-auto">{centerSlot}</div>}
      <div className="flex w-full shrink-0 items-center justify-end gap-3 md:w-auto">{actions}</div>
    </div>
  );
}

// Page-identity header only — icon, title, optional description, optional
// centered content, optional right-side actions. Deliberately doesn't know
// about search/filters/export/refresh/column-controls; those are Toolbar
// concerns that belong to the page itself. Extracted from FloatingHeader
// (Settlement is the reference/first consumer) — visual shell (sticky
// pill, h-14 row, icon/title styling) is unchanged from that component so
// switching to this one is not a redesign.
export default function PageHeader(props: PageHeaderProps) {
  const { icon: Icon, title, description, centerSlot, actions, containerless = false } = props;

  if (containerless) {
    return <ContainerlessHeader {...props} />;
  }

  return (
    <div className="sticky top-4 z-30 mx-4 md:mx-8">
      <header className={FLOATING_HEADER_SHELL_CLASS}>
        <div className="flex h-14 items-center justify-between gap-2 pl-14 pr-4 md:grid md:grid-cols-3 md:pl-5 md:pr-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && (
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white"
                style={{ background: 'var(--ui-accent)' }}
              >
                <Icon size={14} />
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-semibold leading-tight tracking-[-0.01em] text-foreground">{title}</h1>
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
    </div>
  );
}
