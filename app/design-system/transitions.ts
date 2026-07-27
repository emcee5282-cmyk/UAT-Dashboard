// Sidebar width and AppShell's main-content margin animate in lockstep (the
// sidebar's collapse/expand and the content reflow it causes) — this
// duration must stay identical in both places or the two visibly desync.
// Confirmed byte-identical in both consumers before this extraction.
export const SIDEBAR_SYNC_DURATION_CLASS = 'duration-[220ms]';
