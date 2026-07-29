'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';

export type ColumnDropdownOption = {
  key: string;
  label: string;
  visible: boolean;
  /** false = permanently shown, not offered as a toggle (e.g. a pinned column). */
  hideable: boolean;
};

interface ColumnsDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  id?: string;
  columns: ColumnDropdownOption[];
  onToggle: (key: string) => void;
  onRestoreDefaults: () => void;
}

const PANEL_WIDTH = 320;

// Column-visibility panel — same premium shell as FilterDropdown (search,
// rounded 16px panel, 42px rows, live/instant toggling, keyboard nav), minus
// the count badges (columns aren't data-driven) and with a single "Restore
// Defaults" action instead of a Select All/Clear All toggle, since a page's
// defaults aren't necessarily "everything visible."
export default function ColumnsDropdown({
  open,
  onOpenChange,
  anchorRef,
  id,
  columns,
  onToggle,
  onRestoreDefaults,
}: ColumnsDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [rendered, setRendered] = useState(false);

  const hideableColumns = useMemo(() => columns.filter((col) => col.hideable), [columns]);
  const visibleHideableCount = useMemo(
    () => hideableColumns.filter((col) => col.visible).length,
    [hideableColumns]
  );

  useEffect(() => {
    if (open) {
      setSearchQuery('');
      setHighlightedIndex(-1);
      setRendered(true);
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
        setPos({ top: rect.bottom + 8, left });
      }
    } else {
      const timeout = setTimeout(() => setRendered(false), 160);
      return () => clearTimeout(timeout);
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        anchorRef.current && !anchorRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, anchorRef, onOpenChange]);

  useEffect(() => {
    if (open && rendered) searchInputRef.current?.focus();
  }, [open, rendered]);

  const filteredColumns = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return hideableColumns;
    return hideableColumns.filter((col) => col.label.toLowerCase().includes(query));
  }, [hideableColumns, searchQuery]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchQuery]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = Math.min(highlightedIndex + 1, filteredColumns.length - 1);
        setHighlightedIndex(next);
        optionRefs.current[next]?.focus();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next = Math.max(highlightedIndex - 1, 0);
        setHighlightedIndex(next);
        optionRefs.current[next]?.focus();
        return;
      }
      if (event.key === ' ' && highlightedIndex >= 0) {
        const col = filteredColumns[highlightedIndex];
        const isLastVisible = col && col.visible && visibleHideableCount === 1;
        if (col && !isLastVisible) {
          event.preventDefault();
          onToggle(col.key);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filteredColumns, highlightedIndex, visibleHideableCount]);

  if (!rendered || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label="Column visibility"
      style={{ position: 'fixed', top: pos.top, left: pos.left, transformOrigin: 'top right' }}
      className={`z-[9999] flex w-[320px] min-w-[300px] max-w-[340px] max-h-[360px] flex-col overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white shadow-xl transition-[transform,opacity] duration-[160ms] ease-[var(--ease-out-strong)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] ${
        open ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.98]'
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-3 focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#1f1f22]">
          <Search size={14} className="shrink-0 text-[#94A3B8]" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search..."
            className="w-full bg-transparent text-[14px] font-medium text-[#111827] placeholder:text-[#94A3B8] placeholder:font-normal outline-none border-none dark:text-[#E5E7EB]"
          />
        </div>
      </div>

      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto px-2">
        {filteredColumns.map((col, index) => {
          const isLastVisible = col.visible && visibleHideableCount === 1;
          return (
            <div
              key={col.key}
              ref={(el) => { optionRefs.current[index] = el; }}
              role="option"
              aria-selected={col.visible}
              aria-disabled={isLastVisible}
              tabIndex={-1}
              title={isLastVisible ? 'At least one column must stay visible' : undefined}
              onClick={() => { if (!isLastVisible) onToggle(col.key); }}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`flex h-[42px] items-center gap-2 rounded-[10px] px-[14px] py-0 outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB] ${
                isLastVisible
                  ? 'cursor-not-allowed'
                  : `cursor-pointer ${col.visible ? 'bg-[#EFF6FF] dark:bg-[#1e2a3d]' : 'hover:bg-[#F8FAFC] dark:hover:bg-white/5'}`
              } ${index > 0 ? 'mt-1' : ''}`}
            >
              <input
                type="checkbox"
                checked={col.visible}
                disabled={isLastVisible}
                readOnly
                tabIndex={-1}
                className="pointer-events-none h-3.5 w-3.5 shrink-0 accent-[#2563EB] disabled:opacity-40"
              />
              <span className={`truncate text-[14px] font-medium ${isLastVisible ? 'text-[#b3b8c2] dark:text-[#5a5f66]' : 'text-[#111827] dark:text-[#E5E7EB]'}`}>
                {col.label}
              </span>
            </div>
          );
        })}
        {filteredColumns.length === 0 && (
          <div className="flex h-[42px] items-center justify-center text-[13px] text-[#94A3B8]">
            No matches
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-center border-t border-[#F1F5F9] p-3 dark:border-[#2f2f32]">
        <button
          type="button"
          onClick={onRestoreDefaults}
          className="flex h-9 w-full items-center justify-center rounded-[10px] text-[13px] font-medium text-[#2563EB] transition-[background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#EFF6FF] active:scale-[0.97] dark:text-[#60A5FA] dark:hover:bg-white/5"
        >
          Restore Defaults
        </button>
      </div>
    </div>,
    document.body
  );
}
