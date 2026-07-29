'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';

export type FilterDropdownOption = {
  value: string;
  label: string;
  count: number;
};

interface FilterDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  options: FilterDropdownOption[];
  /** Currently APPLIED (committed) selection — what's actually filtering the table right now. */
  selected: Record<string, boolean>;
  onApply: (next: Record<string, boolean>) => void;
}

const PANEL_WIDTH = 320;

// Premium multi-select filter panel — search, counts, staged Apply/Clear All,
// keyboard nav. This is the panel only; each page keeps its own trigger
// button (toolbar pill, header icon, whatever fits that page's layout) and
// just renders this beneath it via `anchorRef`. Selection is staged in a
// local `draft` and only committed to the caller via `onApply` — outside-
// click/Escape discard the draft, matching Linear/Stripe-style filter menus.
export default function FilterDropdown({
  open,
  onOpenChange,
  anchorRef,
  options,
  selected,
  onApply,
}: FilterDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [draft, setDraft] = useState<Record<string, boolean>>(selected);
  const [searchQuery, setSearchQuery] = useState('');
  // -1 = nothing keyboard-highlighted yet (search box still has focus).
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Keeps the portal mounted for 160ms after close so the closing
  // opacity/scale transition (driven by `open` below) can play before React
  // unmounts it.
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (open) {
      // Reseed the draft from the last-applied selection and reposition
      // against the trigger every time the panel opens.
      setDraft(selected);
      setSearchQuery('');
      setHighlightedIndex(-1);
      setRendered(true);
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8));
        setPos({ top: rect.bottom + 8, left });
      }
    } else {
      const timeout = setTimeout(() => setRendered(false), 160);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    // `rendered` (not just `open`) is the real dependency — the search
    // input doesn't exist in the DOM until the portal actually mounts,
    // which happens a render pass after `open` first flips true (see the
    // rendered/mount-delay effect above). Focusing on `open` alone raced
    // the mount and silently no-op'd, which also meant keydown (Escape,
    // arrows) never reached this panel's onKeyDown at all.
    if (open && rendered) searchInputRef.current?.focus();
  }, [open, rendered]);

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(query));
  }, [options, searchQuery]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchQuery]);

  const toggleValue = (value: string) => {
    setDraft((current) => ({ ...current, [value]: !(current[value] !== false) }));
  };

  const isChecked = (value: string) => draft[value] !== false;

  const applyAndClose = () => {
    onApply(draft);
    onOpenChange(false);
  };

  const clearAll = () => {
    setDraft(Object.fromEntries(options.map((opt) => [opt.value, false])));
  };

  // A document-level listener (gated on `open`), not a React onKeyDown on
  // the panel — clicking a row (a plain non-focusable div, per spec: the
  // checkbox itself has no separate behavior) blurs the search input to
  // <body>, and keydown on <body> would never bubble into the panel's own
  // subtree. Space only toggles when focus isn't in the search box, so
  // typing still works normally.
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
        applyAndClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = Math.min(highlightedIndex + 1, filteredOptions.length - 1);
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
        event.preventDefault();
        const opt = filteredOptions[highlightedIndex];
        if (opt) toggleValue(opt.value);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filteredOptions, highlightedIndex, draft]);

  if (!rendered || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Filter"
      style={{ position: 'fixed', top: pos.top, left: pos.left, transformOrigin: 'top left' }}
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
        {filteredOptions.map((opt, index) => {
          const checked = isChecked(opt.value);
          return (
            <div
              key={opt.value}
              ref={(el) => { optionRefs.current[index] = el; }}
              role="option"
              aria-selected={checked}
              tabIndex={-1}
              onClick={() => toggleValue(opt.value)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`flex h-[42px] cursor-pointer items-center justify-between gap-2 rounded-[10px] px-[14px] py-0 outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB] ${
                checked
                  ? 'bg-[#EFF6FF] dark:bg-[#1e2a3d]'
                  : 'hover:bg-[#F8FAFC] dark:hover:bg-white/5'
              } ${index > 0 ? 'mt-1' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  tabIndex={-1}
                  className="pointer-events-none h-3.5 w-3.5 shrink-0 accent-[#2563EB]"
                />
                <span className="truncate text-[14px] font-medium text-[#111827] dark:text-[#E5E7EB]">
                  {opt.label}
                </span>
              </span>
              <span className="shrink-0 rounded-[6px] bg-[#F1F5F9] px-2.5 py-[3px] text-[12px] font-medium text-[#64748B] dark:bg-white/10 dark:text-[#9CA3AF]">
                {opt.count.toLocaleString('en-US')}
              </span>
            </div>
          );
        })}
        {filteredOptions.length === 0 && (
          <div className="flex h-[42px] items-center justify-center text-[13px] text-[#94A3B8]">
            No matches
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#F1F5F9] p-3 dark:border-[#2f2f32]">
        <button
          type="button"
          onClick={clearAll}
          className="flex h-9 items-center rounded-[10px] px-3 text-[13px] font-medium text-[#475569] transition-colors duration-150 hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
        >
          Clear All
        </button>
        <button
          type="button"
          onClick={applyAndClose}
          className="flex h-9 items-center rounded-[10px] bg-[#2563EB] px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#1D4ED8] active:scale-[0.97]"
        >
          Apply
        </button>
      </div>
    </div>,
    document.body
  );
}
