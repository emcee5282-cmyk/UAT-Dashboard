import { TABLE_STICKY_HEADER_SHADOW_CLASS } from './shadows';

// Full className for a native <table>'s sticky <thead> — confirmed
// byte-identical across every Design System v2 page rendering a native
// table (Balance, Opening, Top Up, Transfer Queue and their Send Money
// counterparts) before this extraction. Settlement uses CSS Grid instead
// (a table-layout:fixed workaround) and isn't part of this set.
export const TABLE_STICKY_HEADER_CLASS =
  `sticky top-0 z-[50] bg-white dark:bg-[#252528] border-b border-border ${TABLE_STICKY_HEADER_SHADOW_CLASS}`;

// Header-cell typography shared by the same page set's own
// `headerCellClasses()` helpers — every one of them returns this exact
// string; only the active/sort-state branching logic around it (which
// stays page-specific) differs.
export const TABLE_HEADER_CELL_CLASS =
  'text-center px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground';

// Toolbar override classNames — confirmed byte-identical across Balance,
// Opening, Top Up and Transfer Queue (the four pages built directly against
// the shared Toolbar component at this density).
export const TOOLBAR_ROW_CLASS =
  'shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2';
export const TOOLBAR_LEFT_CLASS = 'flex flex-wrap items-center gap-2';
export const TOOLBAR_RIGHT_CLASS = 'flex items-center gap-2';
