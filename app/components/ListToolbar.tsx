'use client';

// Toolbar pieces shared with Pending Balance's tabs — the rounded search
// pill and the Export button — so new list pages (Users) match it exactly
// instead of re-styling. Classes are copied verbatim from
// app/monitoring/pending-balance/StagnantBalancesTab.tsx (which keeps its
// own local copies, per that file's established convention).
import { Search } from 'lucide-react';

export const EXPORT_BUTTON_CLASS =
  'flex h-8 w-8 xl:w-auto shrink-0 items-center justify-center xl:justify-start gap-[5px] rounded-[10px] border border-[#E2E8F0] bg-white px-0 xl:px-[10px] text-[11px] font-medium text-[#475569] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:pointer-events-none disabled:opacity-50 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Same shell as Export, filled with the accent — for the page's one primary
// action (Add user / Create role).
export const PRIMARY_TOOLBAR_BUTTON_CLASS =
  'flex h-8 shrink-0 items-center gap-[5px] rounded-[10px] bg-[var(--ui-accent)] px-[10px] text-[11px] font-medium text-white transition-[filter,transform] duration-150 ease-[var(--ease-out-strong)] hover:brightness-95 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:pointer-events-none disabled:opacity-50';

// Table chrome (Pending Balance's tables).
export const TABLE_WRAPPER_CLASS = 'relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-[#DEE1E8] dark:border-[#262B38]';
export const TH_CLASS =
  'sticky top-0 z-[2] border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#262B38] dark:bg-[#0E1119]';
export const TR_CLASS = 'dt-row-stagger-in border-b border-[#ECEFF3] dark:border-[#1A1E29]';
export const TD_CLASS = 'px-5 py-2';

export function SearchPill({
  value,
  onChange,
  loading,
  placeholder = 'Search for anything',
}: {
  value: string;
  onChange: (v: string) => void;
  loading?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="flex h-8 w-[280px] shrink-0 items-center gap-[6px] rounded-full border border-[#E5E7EB] bg-white px-[13px] transition-colors focus-within:border-[var(--ui-accent)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]/20 dark:border-[#262B38] dark:bg-[#12151D]">
      {loading ? (
        <div className="dt-skeleton h-[10px] w-32 rounded-md" />
      ) : (
        <>
          <Search size={13} className="shrink-0 text-[#475569] dark:text-[#9CA3AF]" />
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={placeholder}
            className="flex-1 bg-transparent text-[11px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
            placeholder={placeholder}
          />
        </>
      )}
    </div>
  );
}
