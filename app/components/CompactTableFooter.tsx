'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

// Forked from the shared TableFooter.tsx and scaled to 80% for pages using
// the compact table density (Wallet Status, Transfer Queue) — kept as its
// own file (rather than editing TableFooter.tsx directly) so every OTHER
// page using the shared TableFooter (Settlement, Top Up, etc.) keeps its
// own full-size footer, unaffected.
//
// Was briefly bumped to the full-size 13px text to "mimic" Transfer
// Queue's own footer — wrong direction: Transfer Queue's table body is
// ALSO compact (11px), its footer had just never been scaled down to
// match, so copying it just spread the same mismatch to Wallet Status.
// Reverted back to compact sizing here and swapped Transfer Queue over to
// this component too, so the fix applies to the actual source instead.

// Windowed page list for the numbered pager — full run for small page
// counts, otherwise first/last pinned with an ellipsis and a window around
// the current page (1 … 4 5 6 … 12).
function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const result: (number | 'ellipsis')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) result.push('ellipsis');
    result.push(p);
  });
  return result;
}

type CompactTableFooterProps = {
  recordCountText: string;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  totalRecords?: number;
  variant?: 'default' | 'premium';
};

export default function CompactTableFooter({ recordCountText, currentPage, totalPages, onPageChange, pageSize, pageSizeOptions, onPageSizeChange, totalRecords, variant = 'default' }: CompactTableFooterProps) {
  // --ui-accent (not --product-accent) throughout this component,
  // deliberately — pagination/footer chrome is universal UI, not product
  // branding, so it must stay indigo/gold on every page, never pick up Send
  // Money's teal. Same fix as ProductSwitchTabs' own pills.
  const showSelector = pageSizeOptions && onPageSizeChange && totalRecords !== undefined;
  if (variant === 'premium') {
    return (
      <div className="shrink-0 flex h-[48px] items-center justify-between gap-[10px] border-t border-[#E5E7EB] px-[13px] dark:border-[#3a3a3d]">
        {showSelector ? (
          <div className="flex items-center gap-[6px] whitespace-nowrap text-[11px] font-medium text-[#64748B]">
            <span className="font-semibold text-[var(--ui-accent)]">Show</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange!(Number(event.target.value))}
              aria-label="Rows per page"
              className="h-[26px] rounded-[6px] border border-[#E5E7EB] bg-white px-[6px] text-[11px] font-medium text-[#475569] outline-none transition-colors focus-visible:border-[var(--ui-accent)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
            >
              {pageSizeOptions!.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>of {totalRecords!.toLocaleString()} entries</span>
          </div>
        ) : (
          <span className="whitespace-nowrap text-[11px] font-medium text-[#64748B]">{recordCountText}</span>
        )}
        {totalPages > 1 && (
          <div className="flex items-center gap-[2px] rounded-full border border-border bg-muted/40 p-[3px] dark:bg-white/5">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-out hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronLeft size={12} />
            </button>
            {getPageNumbers(currentPage, totalPages).map((p, idx) =>
              p === 'ellipsis' ? (
                <span key={`ellipsis-${idx}`} className="flex h-[26px] w-[26px] items-center justify-center text-[11px] text-muted-foreground">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  aria-label={`Page ${p}`}
                  aria-current={p === currentPage ? 'page' : undefined}
                  className={`flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-medium transition-colors duration-150 ease-out ${
                    p === currentPage
                      ? 'bg-[var(--ui-accent)] text-white'
                      : 'text-muted-foreground hover:bg-white dark:hover:bg-white/10'
                  }`}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              aria-label="Next page"
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-out hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="shrink-0 flex h-[48px] items-center justify-between gap-[10px] border-t border-[#E5E7EB] px-[13px] dark:border-[#3a3a3d]">
      {showSelector ? (
        <div className="flex items-center gap-[6px] whitespace-nowrap text-[10px] font-medium text-[#64748B]">
          <span className="font-semibold text-[var(--ui-accent)]">Show</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange!(Number(event.target.value))}
            aria-label="Rows per page"
            className="h-[26px] rounded-[6px] border border-[#E5E7EB] bg-white px-[6px] text-[10px] font-medium text-[#475569] outline-none transition-colors focus-visible:border-[var(--ui-accent)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
          >
            {pageSizeOptions!.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>of {totalRecords!.toLocaleString()} entries</span>
        </div>
      ) : (
        <span className="whitespace-nowrap text-[10px] font-medium text-[#64748B]">{recordCountText}</span>
      )}
      <div className="flex items-center gap-[13px]">
        {totalPages > 1 && (
          <div className="flex items-center gap-[5px]">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              className="flex h-[29px] w-[29px] items-center justify-center rounded-[6px] border border-[#E5E7EB] text-[#475569] transition-colors duration-200 ease-out hover:bg-[#EFF6FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <ChevronLeft size={13} />
            </button>
            {getPageNumbers(currentPage, totalPages).map((p, idx) =>
              p === 'ellipsis' ? (
                <span key={`ellipsis-${idx}`} className="flex h-[29px] w-[29px] items-center justify-center text-[11px] text-[#94A3B8]">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  aria-label={`Page ${p}`}
                  aria-current={p === currentPage ? 'page' : undefined}
                  className={`flex h-[29px] w-[29px] items-center justify-center rounded-[6px] text-[11px] font-medium transition-colors duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] ${
                    p === currentPage
                      ? 'bg-[var(--ui-accent)] text-white'
                      : 'text-[#475569] hover:bg-[#EFF6FF] dark:text-[#9CA3AF] dark:hover:bg-white/5'
                  }`}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              aria-label="Next page"
              className="flex h-[29px] w-[29px] items-center justify-center rounded-[6px] border border-[#E5E7EB] text-[#475569] transition-colors duration-200 ease-out hover:bg-[#EFF6FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
