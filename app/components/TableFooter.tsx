'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

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

type TableFooterProps = {
  recordCountText: string;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  // Rows-per-page selector — all four optional and only rendered together
  // (as one combined "Show [size] of {totalRecords} entries" cluster,
  // replacing recordCountText's own span); omitted entirely by every
  // pre-existing caller, so this is purely additive (no layout change for
  // pages that don't pass them).
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  totalRecords?: number;
  // 'default' (unchanged) everywhere except Settlement, which opted into
  // 'premium' — a rounded-pill pager with a gradient active-page circle,
  // copied from a reference design. Style only: same page-number math,
  // same onPageChange/onPageSizeChange wiring, same position in the footer.
  variant?: 'default' | 'premium';
};

// Shared table footer: record count pinned left, pagination pinned right,
// fixed height regardless of whether pagination actually renders — so the
// footer never grows/shrinks depending on the current page count. Built by
// extracting Settlement's own footer verbatim (first consumer); nothing
// else wired up to it yet.
export default function TableFooter({ recordCountText, currentPage, totalPages, onPageChange, pageSize, pageSizeOptions, onPageSizeChange, totalRecords, variant = 'default' }: TableFooterProps) {
  const showSelector = pageSizeOptions && onPageSizeChange && totalRecords !== undefined;
  if (variant === 'premium') {
    return (
      <div className="shrink-0 flex h-[60px] items-center justify-between gap-3 border-t border-[#E5E7EB] px-4 dark:border-[#3a3a3d]">
        {showSelector ? (
          <div className="flex items-center gap-2 whitespace-nowrap text-[13px] font-medium text-[#64748B]">
            <span className="font-semibold text-[#2563EB]">Show</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange!(Number(event.target.value))}
              aria-label="Rows per page"
              className="h-8 rounded-[8px] border border-[#E5E7EB] bg-white px-2 text-[12px] font-medium text-[#475569] outline-none transition-colors focus-visible:border-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
            >
              {pageSizeOptions!.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>of {totalRecords!.toLocaleString()} entries</span>
          </div>
        ) : (
          <span className="whitespace-nowrap text-[13px] font-medium text-[#64748B]">{recordCountText}</span>
        )}
        {totalPages > 1 && (
          <div className="flex items-center gap-0.5 rounded-full border border-border bg-muted/40 p-1 dark:bg-white/5">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-out hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronLeft size={15} />
            </button>
            {getPageNumbers(currentPage, totalPages).map((p, idx) =>
              p === 'ellipsis' ? (
                <span key={`ellipsis-${idx}`} className="flex h-8 w-8 items-center justify-center text-[13px] text-muted-foreground">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  aria-label={`Page ${p}`}
                  aria-current={p === currentPage ? 'page' : undefined}
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-medium transition-colors duration-150 ease-out ${
                    p === currentPage
                      ? 'text-white shadow-[0_2px_8px_-1px_var(--product-accent)]'
                      : 'text-muted-foreground hover:bg-white dark:hover:bg-white/10'
                  }`}
                  style={p === currentPage ? { background: 'var(--product-accent)' } : undefined}
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
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-out hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="shrink-0 flex h-[60px] items-center justify-between gap-3 border-t border-[#E5E7EB] px-4 dark:border-[#3a3a3d]">
      {showSelector ? (
        <div className="flex items-center gap-2 whitespace-nowrap text-[13px] font-medium text-[#64748B]">
          <span className="font-semibold text-[#2563EB]">Show</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange!(Number(event.target.value))}
            aria-label="Rows per page"
            className="h-8 rounded-[8px] border border-[#E5E7EB] bg-white px-2 text-[12px] font-medium text-[#475569] outline-none transition-colors focus-visible:border-[#2563EB] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF]"
          >
            {pageSizeOptions!.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>of {totalRecords!.toLocaleString()} entries</span>
        </div>
      ) : (
        <span className="whitespace-nowrap text-[13px] font-medium text-[#64748B]">{recordCountText}</span>
      )}
      <div className="flex items-center gap-4">
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#E5E7EB] text-[#475569] transition-colors duration-200 ease-out hover:bg-[#EFF6FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <ChevronLeft size={16} />
            </button>
            {getPageNumbers(currentPage, totalPages).map((p, idx) =>
              p === 'ellipsis' ? (
                <span key={`ellipsis-${idx}`} className="flex h-9 w-9 items-center justify-center text-[13px] text-[#94A3B8]">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  aria-label={`Page ${p}`}
                  aria-current={p === currentPage ? 'page' : undefined}
                  className={`flex h-9 w-9 items-center justify-center rounded-[8px] text-[13px] font-medium transition-colors duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] ${
                    p === currentPage
                      ? 'bg-[#2563EB] text-white'
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
              className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#E5E7EB] text-[#475569] transition-colors duration-200 ease-out hover:bg-[#EFF6FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
