'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Check } from 'lucide-react';

export type DateRangeValue = { from: string; to: string }; // 'YYYY-MM-DD', inclusive, Manila

type DateRangeFilterProps = {
  mode: 'picker' | 'locked';
  value: DateRangeValue;
  availableDates: string[]; // 'YYYY-MM-DD', Manila
  today: string;            // 'YYYY-MM-DD', Manila — Effective Today, resolved server-side, never computed here
  onApply: (value: DateRangeValue) => void;
};

const PANEL_WIDTH = 560;
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// ---- plain 'YYYY-MM-DD' string helpers — no Date-object timezone drift ----
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function monthStartIso(iso: string): string {
  return iso.slice(0, 8) + '01';
}
function shortLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}
function rangeLabel(from: string, to: string): string {
  return from === to ? shortLabel(from) : `${shortLabel(from)} – ${shortLabel(to)}`;
}
function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

export type DateRangePreset = 'today' | 'week' | 'month';

// Exported — pages also need these to compute the delta badge's label text
// ("vs yesterday" / "vs previous N days" / "vs same days last month"),
// which depends on which preset (if any) the applied range matches.
export function presets(today: string): Record<DateRangePreset, DateRangeValue> {
  return {
    today: { from: today, to: today },
    week: { from: addDaysIso(today, -6), to: today },
    month: { from: monthStartIso(today), to: today },
  };
}
export const PRESET_NAME: Record<DateRangePreset, string> = { today: 'Today', week: 'Last 7 days', month: 'This month' };

export function presetOf(value: DateRangeValue, today: string): DateRangePreset | null {
  const p = presets(today);
  for (const key of ['today', 'week', 'month'] as const) {
    if (p[key].from === value.from && p[key].to === value.to) return key;
  }
  return null;
}
export { rangeLabel, daysInRange };

function chipLabel(mode: 'picker' | 'locked', value: DateRangeValue, today: string): string {
  if (mode === 'locked') return `This month · ${rangeLabel(value.from, value.to)}`;
  const preset = presetOf(value, today);
  return preset ? PRESET_NAME[preset] : rangeLabel(value.from, value.to);
}

export default function DateRangeFilter({ mode, value, availableDates, today, onApply }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [draft, setDraft] = useState<DateRangeValue>(value);
  const [pickingStart, setPickingStart] = useState<string | null>(null); // first-click anchor of an in-progress range pick
  const [viewMonth, setViewMonth] = useState<string>(monthStartIso(value.to));

  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const available = new Set(availableDates);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
        setPos({ top: rect.bottom + 8, left: Math.max(8, left) });
      }
    } else {
      const timeout = setTimeout(() => setRendered(false), 160);
      return () => clearTimeout(timeout);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        anchorRef.current && !anchorRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        closePop();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePop();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openPop() {
    setDraft(value);
    setViewMonth(monthStartIso(value.to));
    setPickingStart(null);
    setOpen(true);
  }
  function closePop() {
    setOpen(false);
  }
  function applyDraft() {
    onApply(draft);
    setOpen(false);
  }

  function pickDay(iso: string) {
    if (pickingStart === null) {
      setDraft({ from: iso, to: iso });
      setPickingStart(iso);
    } else if (iso >= pickingStart) {
      setDraft({ from: pickingStart, to: iso });
      setPickingStart(null);
    } else {
      setDraft({ from: iso, to: iso });
      setPickingStart(iso);
    }
  }

  function pickPreset(key: 'today' | 'week' | 'month') {
    const next = presets(today)[key];
    setDraft(next);
    setViewMonth(monthStartIso(next.to));
    setPickingStart(null);
  }

  if (mode === 'locked') {
    return (
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap rounded-md bg-muted px-2 py-[3px] text-[11px] font-semibold text-muted-foreground">
          {chipLabel('locked', value, today)}
        </span>
        <button
          type="button"
          disabled
          aria-label="Date range fixed to this month"
          className="grid h-[30px] w-[30px] shrink-0 cursor-default place-items-center rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground/50"
        >
          <CalendarIcon size={15} />
        </button>
      </div>
    );
  }

  const [vy, vm] = viewMonth.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(vy, vm - 1, 1)).getUTCDay();
  const daysCount = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysCount }, (_, i) => `${vy}-${String(vm).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`),
  ];
  const prevMonth = addDaysIso(monthStartIso(viewMonth), -1).slice(0, 8) + '01';
  const nextMonth = addDaysIso(`${viewMonth.slice(0, 8)}${String(daysCount).padStart(2, '0')}`, 1);
  const hasDataInMonth = (ms: string) => {
    const [y, m] = ms.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return daysInRange(ms, `${ms.slice(0, 8)}${String(last).padStart(2, '0')}`).some((d) => available.has(d));
  };
  const canPrev = hasDataInMonth(prevMonth);
  const canNext = nextMonth <= today && hasDataInMonth(monthStartIso(nextMonth));

  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap rounded-md bg-[color:var(--ui-accent-soft)] px-2 py-[3px] text-[11px] font-semibold text-[color:var(--ui-accent)]">
        {chipLabel('picker', value, today)}
      </span>
      <button
        ref={anchorRef}
        type="button"
        aria-label="Date range"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closePop() : openPop())}
        className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border transition-colors ${
          open ? 'border-[color:var(--ui-accent)] bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-[#1c1c1e]'
        }`}
      >
        <CalendarIcon size={15} />
      </button>

      {rendered && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose date range"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, maxWidth: 'calc(100vw - 32px)' }}
          className={`z-[9999] flex flex-col rounded-xl border border-border bg-white shadow-lg transition-[opacity,transform] duration-[160ms] dark:bg-[#2a2a2d] ${
            open ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'
          }`}
        >
          <div className="flex">
            <div className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-border p-1.5 dark:border-[#3a3a3d]">
              <span className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Quick select</span>
              {(['today', 'week', 'month'] as const).map((key) => {
                const p = presets(today)[key];
                const active = presetOf(draft, today) === key;
                const disabled = !daysInRange(p.from, p.to).some((d) => available.has(d));
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    onClick={() => pickPreset(key)}
                    className={`flex items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                      disabled
                        ? 'cursor-not-allowed text-muted-foreground/40'
                        : active
                          ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]'
                          : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <span>
                      <span className="block text-[12px] font-semibold">{PRESET_NAME[key]}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{rangeLabel(p.from, p.to)}</span>
                    </span>
                    {active && <Check size={14} className="shrink-0" />}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-1 flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  disabled={!canPrev}
                  onClick={() => setViewMonth(prevMonth)}
                  className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:border-border/50 disabled:text-muted-foreground/30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft size={13} />
                </button>
                <span className="text-[13px] font-bold text-foreground">{MONTH_FULL[vm - 1]} {vy}</span>
                <button
                  type="button"
                  disabled={!canNext}
                  onClick={() => setViewMonth(monthStartIso(nextMonth))}
                  className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:border-border/50 disabled:text-muted-foreground/30 disabled:hover:bg-transparent"
                >
                  <ChevronRight size={13} />
                </button>
              </div>
              <div className="grid grid-cols-7 gap-[2px]">
                {WEEKDAY_LABELS.map((label, i) => (
                  <span key={i} className="py-1 text-center text-[10px] font-semibold text-muted-foreground">{label}</span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-[2px]">
                {cells.map((iso, i) => {
                  if (iso === null) return <span key={i} className="invisible h-8" />;
                  const ok = available.has(iso) && iso <= today;
                  const isToday = iso === today;
                  const inRange = iso > draft.from && iso < draft.to;
                  const isEdge = iso === draft.from || iso === draft.to;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={!ok}
                      aria-label={shortLabel(iso) + (ok ? '' : ', no data')}
                      onClick={() => pickDay(iso)}
                      className={`h-8 rounded-md text-[12px] font-medium transition-colors ${
                        !ok
                          ? 'cursor-not-allowed text-muted-foreground/30 line-through'
                          : isEdge
                            ? 'bg-[color:var(--ui-accent)] font-bold text-white'
                            : inRange
                              ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]'
                              : isToday
                                ? 'border border-[color:var(--ui-accent)] font-bold text-foreground hover:bg-muted'
                                : 'text-foreground hover:bg-muted'
                      }`}
                    >
                      {parseInt(iso.slice(8, 10), 10)}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-3.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-foreground" />Has data</span>
                <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/30" />No data (disabled)</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5 dark:border-[#3a3a3d]">
            <span className="text-[12px] text-muted-foreground">
              Selected: <b className="font-semibold text-foreground">{rangeLabel(draft.from, draft.to)}, {draft.to.slice(0, 4)}</b>
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={closePop} className="rounded-lg border border-border px-3.5 py-[7px] text-[12px] text-muted-foreground transition-colors hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={applyDraft}
                className="rounded-lg border border-[color:var(--ui-accent)] bg-[color:var(--ui-accent)] px-3.5 py-[7px] text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                Apply
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
