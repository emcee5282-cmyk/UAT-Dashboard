'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const CALENDAR_WIDTH = 260;

function formatDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseDisplayValue(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Calendar-only date entry — the trigger is a <button>, not a text <input>,
// so there is no way to type an invalid/malformed date at all (the one
// explicit requirement this control exists to satisfy). Reusable wherever a
// date field is needed (Settlement today; other modules later per spec).
type DateInputProps = {
  id?: string;
  value: string; // formatted display string, e.g. "Jul 23, 2026"; '' = unset
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: boolean;
};

export default function DateInput({ id, value, onChange, onBlur, error }: DateInputProps) {
  const [open, setOpen] = useState(false);
  const selected = parseDisplayValue(value);
  const [viewMonth, setViewMonth] = useState(() => selected ?? new Date());
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 0, top: 0, maxHeight: 9999 });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
        onBlur?.();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, onBlur]);

  // Panel is portaled to document.body and positioned in fixed coordinates
  // measured off the trigger button's real screen position — a modal's own
  // overflow/scroll clipping (the reported bug: the calendar got cut off at
  // the bottom of the Settlement "New Record" modal whenever Date sat low in
  // the form) can no longer clip it, since it's no longer a descendant of
  // that scroll container at all. Flips to open ABOVE the button instead of
  // below whenever the viewport doesn't have room beneath it — same "flip if
  // it doesn't fit" behavior a native <select>/date picker uses.
  //
  // The flip decision and the final position both use the panel's REAL
  // rendered height (menuRef.offsetHeight) — not a guessed constant. An
  // earlier version guessed a fixed height for the flip decision, which
  // over-triggered the flip in cases with plenty of genuine room below
  // simply because the guess overshot the panel's true height (4/5/6 week
  // rows render at different real heights). No two-pass measurement dance
  // is needed to get the real number: the portal's children commit to the
  // DOM synchronously as part of the same render, so by the time this
  // layout effect runs (always before paint), menuRef.current already
  // reflects the panel's true, final layout.
  //
  // When flipped, `top` isn't touched at all — `bottom` (distance from the
  // button's own top edge up to the viewport's bottom) is what's set, so
  // the browser grows the box upward from that fixed edge using its real
  // height; it always sits flush against the button (an earlier version
  // computed `top` from the same guessed height instead, which left a
  // visible gap floating the panel well above the field — reported live).
  // `maxHeight` + scroll is just a safety net for the rare case where even
  // the full space on the chosen side isn't enough.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelHeight = menuRef.current?.offsetHeight ?? 0;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - CALENDAR_WIDTH - 8));
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const fitsBelow = spaceBelow >= panelHeight + 8;
      const openUp = !fitsBelow && spaceAbove > spaceBelow;
      if (openUp) {
        setPos({ left, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(120, spaceAbove - 12) });
      } else {
        setPos({ left, top: rect.bottom + 4, maxHeight: Math.max(120, spaceBelow - 12) });
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
    // viewMonth is a dependency too — navigating to a month with a
    // different week-row count (4/5/6) changes the panel's real height,
    // which can change whether it still fits on its current side.
  }, [open, viewMonth]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  function selectDay(day: number) {
    if (isFutureDay(day)) return;
    onChange(formatDisplay(new Date(year, month, day)));
    setOpen(false);
    onBlur?.();
  }

  // "Today" is recomputed on every render (not memoized/cached), so a
  // modal left open across midnight still enforces the correct cutoff —
  // always the user's own local date, never a stale snapshot.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isToday = (day: number) => today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
  const isSelected = (day: number) =>
    !!selected && selected.getFullYear() === year && selected.getMonth() === month && selected.getDate() === day;
  const isFutureDay = (day: number) => new Date(year, month, day).getTime() > today.getTime();
  // Once the visible month is the current month (or later), there is
  // nothing selectable further ahead — every day next month onward would
  // be fully disabled, so the forward arrow itself is disabled instead of
  // navigating into a dead end.
  const canGoNext = year < today.getFullYear() || (year === today.getFullYear() && month < today.getMonth());

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        id={id}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={`flex h-10 w-full items-center justify-between rounded-lg border bg-white px-3 text-left text-[13px] transition-colors focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 dark:bg-[#1c1c1e] ${
          error ? 'border-rose-400' : 'border-border'
        } ${value ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {value || 'Select date'}
        <CalendarIcon size={14} className="shrink-0 text-muted-foreground" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            width: CALENDAR_WIDTH,
            maxHeight: pos.maxHeight,
            overflowY: 'auto',
          }}
          className="z-[9999] rounded-lg border border-border bg-white p-3 shadow-lg dark:bg-[#2a2a2d]"
        >
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setViewMonth(new Date(year, month - 1, 1))} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <ChevronLeft size={14} />
            </button>
            <span className="text-[12px] font-semibold text-foreground">{MONTH_NAMES[month]} {year}</span>
            <button
              type="button"
              disabled={!canGoNext}
              onClick={() => setViewMonth(new Date(year, month + 1, 1))}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
            {WEEKDAY_LABELS.map((label, i) => <div key={i}>{label}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((day, i) => {
              const disabled = day === null || isFutureDay(day);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => day && selectDay(day)}
                  className={`h-7 rounded-md text-[12px] transition-colors ${
                    day === null
                      ? ''
                      : isFutureDay(day)
                        ? 'cursor-not-allowed text-muted-foreground/40'
                        : isSelected(day)
                          ? 'bg-[#2563EB] text-white'
                          : isToday(day)
                            ? 'border border-[#2563EB] text-[#2563EB]'
                            : 'text-foreground hover:bg-muted'
                  }`}
                >
                  {day ?? ''}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
