// The ticket table (page.tsx) and detail view ([id]/page.tsx) are full-
// width siblings under this layout — no more persistent side panel (see
// their own files for the table+list-fetching and detail+chat logic,
// respectively, each now self-contained).
//
// flex-col (not just flex/row, the bug this was) — a bare `flex` defaults
// to row direction, and a row-flex child with no flex-grow of its own
// shrinks to its content's natural width instead of stretching to fill the
// available space. That silently capped both pages' own `max-w-[1400px]`
// wrapper at ~780px (the table's intrinsic content width) regardless of
// the max-w value, and broke `mx-auto` centering along with it — confirmed
// live via getBoundingClientRect during the typography pass.
//
// bg is Operations Overview's own --ink-0, both themes (#F7F8FA light /
// #0A0D12 dark, app/page.tsx) — not this app's generic surface colors
// (#f5f5f7 / #1c1c1e), which read as visibly different side by side, per
// explicit instruction to match Overview's page bg, not just its card fills.
export default function StaffTicketsLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen w-full flex-col overflow-hidden bg-[#F7F8FA] font-sans text-foreground dark:bg-[#0A0D12]">{children}</div>;
}
