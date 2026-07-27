'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

// Generic searchable combobox — reusable across any module's form (Settlement
// today; Users/Agents/Wallets later per spec). Two modes: closed set
// (allowCustom false, the default — typed text that doesn't match an option
// is rejected on blur/close, reverting to the last committed value) or
// open-ended (allowCustom true — typed free text is accepted as-is, options
// are just suggestions). Never renders the browser's native <select>/
// validation UI — filtering, highlight, and commit are all handled here so
// behavior stays identical regardless of which module embeds it.
type SearchableComboboxProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  options: string[];
  allowCustom?: boolean;
  placeholder?: string;
  error?: boolean;
  disabled?: boolean;
};

export default function SearchableCombobox({
  id,
  value,
  onChange,
  onBlur,
  options,
  allowCustom = false,
  placeholder,
  error,
  disabled,
}: SearchableComboboxProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  // True right after opening via chevron/click/ArrowDown (before any typing)
  // — shows every option regardless of the current committed value, so
  // re-opening an already-filled field "Browses" the full list rather than
  // "Searching" against its own stale value. The instant the user types
  // (onChange), this flips off and real-time filtering takes over.
  const [browseAll, setBrowseAll] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the visible text in sync whenever the committed value changes from
  // outside (e.g. the modal resetting on open) — not on every keystroke,
  // which is `query`'s own job while the popup is open.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = browseAll || query.trim() === ''
    ? options
    : options.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()));

  function openBrowsing() {
    setOpen(true);
    setBrowseAll(true);
  }

  function commitOrRevert() {
    const trimmed = query.trim();
    if (trimmed === '') {
      onChange('');
      setQuery('');
      return;
    }
    if (allowCustom) {
      onChange(trimmed);
      setQuery(trimmed);
      return;
    }
    const match = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
    if (match) {
      onChange(match);
      setQuery(match);
    } else {
      // No custom values allowed — typed junk that never matched an option
      // is rejected, not silently kept.
      setQuery(value);
    }
  }

  function selectOption(option: string) {
    onChange(option);
    setQuery(option);
    setOpen(false);
    setBrowseAll(false);
    setHighlightIndex(0);
  }

  return (
    <div className="relative">
      <div
        className={`flex h-10 items-center gap-2 rounded-lg border bg-white px-3 transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:bg-[#1c1c1e] ${
          error ? 'border-rose-400' : 'border-border'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={id ? `${id}-listbox` : undefined}
          disabled={disabled}
          value={query}
          placeholder={placeholder}
          // Opens on an explicit click/keystroke/ArrowDown, NOT on focus
          // alone — a combobox that auto-opens the instant it receives
          // focus also auto-opens the moment something else focuses it
          // programmatically (e.g. a modal auto-focusing its first field on
          // open), and the resulting floating listbox then visually
          // overlaps whatever field sits right below it, intercepting that
          // field's own clicks. Requiring a real interaction avoids that
          // entirely while still opening for every real usage pattern.
          // Clicking the input itself is the "Browse" gesture too (shows
          // everything) — typing is what narrows it down.
          onClick={openBrowsing}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setBrowseAll(false);
            setHighlightIndex(0);
          }}
          onBlur={() => {
            // A click on a dropdown option never reaches here at all — its
            // own onMouseDown calls preventDefault, which stops the browser
            // from shifting focus off this input in the first place. So any
            // blur that does fire is a genuine focus-away (Tab, clicking
            // elsewhere), safe to commit/revert immediately.
            setOpen(false);
            setBrowseAll(false);
            commitOrRevert();
            onBlur?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!open) openBrowsing();
              setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlightIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (open && filtered[highlightIndex]) {
                selectOption(filtered[highlightIndex]);
              } else if (allowCustom && query.trim()) {
                selectOption(query.trim());
              }
            } else if (event.key === 'Escape' && open) {
              // Only the popup closes on this Escape — stopPropagation keeps
              // it from also bubbling up to the modal's own Escape-closes
              // handler, so a second, separate Escape press is what's
              // needed to close the whole modal.
              event.stopPropagation();
              setOpen(false);
              setBrowseAll(false);
              setQuery(value);
            }
          }}
          className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {/* Mouse-only trigger (tabIndex -1: doesn't add a Tab stop — keyboard
            users open/browse via ArrowDown on the input itself instead).
            onMouseDown preventDefault keeps focus on the input throughout,
            same guard the option buttons below use. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label="Show all options"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            inputRef.current?.focus();
            setOpen((current) => {
              const next = !current;
              if (next) setBrowseAll(true);
              return next;
            });
          }}
          className="shrink-0 text-muted-foreground disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && filtered.length > 0 && (
        <div
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-lg dark:bg-[#2a2a2d]"
        >
          {filtered.map((option, i) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectOption(option)}
              className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                i === highlightIndex ? 'bg-[#EFF6FF] text-[#2563EB] dark:bg-[#1e2a3d] dark:text-[#60a5fa]' : 'text-foreground hover:bg-muted'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
