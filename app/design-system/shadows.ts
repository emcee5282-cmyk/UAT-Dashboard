// Shadow values confirmed byte-identical across multiple existing
// components/pages before this extraction — centralized so a future tweak
// applies everywhere at once instead of needing a find-and-replace across
// every consumer. Nothing visual changes by switching a consumer to import
// these; each value is copied verbatim from its original inline occurrence.

// PageHeader.tsx + FloatingHeader.tsx's floating header shell (rounded
// pill, translucent white, backdrop blur, drop shadow) — byte-identical in
// both components before this extraction.
export const FLOATING_HEADER_SHELL_CLASS =
  'rounded-xl border border-border bg-white/95 shadow-lg backdrop-blur-sm dark:bg-[#0d1117]/95';

// Sticky <thead> shadow — only visible once real content has scrolled
// underneath it. Shared by every Design System v2 page still rendering a
// native <table> (as opposed to Settlement's CSS Grid).
export const TABLE_STICKY_HEADER_SHADOW_CLASS =
  'shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]';
