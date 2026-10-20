// Pure decision logic for the Discrepancy TG auto-send — no I/O, so the
// window/upload/once-per-slot rules can be unit-tested in isolation
// (scripts/_verify-discrepancy-tg-auto-slot.ts).
//
// Rule (per explicit instruction): clicking Operations Overview's own
// "Send to Telegram" (the CIH send) also fires the full Discrepancy TG
// send when ALL of these hold:
//   1. now is inside a slot window — 12PM / 3PM / 6PM / 9PM, from 20 min
//      before to 30 min after, in GMT+8 (Asia/Manila), NOT BD time;
//   2. at least one product's Balance Limit upload landed inside that same
//      window (both products are still sent either way — each image's own
//      "Last update" header, in BD time, tells the agent how fresh it is);
//   3. this slot hasn't auto-sent yet today.
// A manual Discrepancy send in the same window does NOT count toward 3 —
// the auto send still goes out.
import { manilaFields, manilaMidnight } from './businessDate';

export const AUTO_SEND_SLOT_HOURS = [12, 15, 18, 21] as const;
const WINDOW_BEFORE_MS = 20 * 60 * 1000;
const WINDOW_AFTER_MS = 30 * 60 * 1000;

export type AutoSendSlot = {
  key: string; // "2026-10-20 12PM" — Manila date + slot, unique per slot per day
  windowStart: Date;
  windowEnd: Date;
};

export type AutoSendDecision =
  | { send: true; slot: AutoSendSlot }
  | { send: false; reason: 'outside-window' | 'no-upload-in-window' | 'already-sent'; slot: AutoSendSlot | null };

function slotLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? 'AM' : 'PM'}`;
}

export function findAutoSendSlot(now: Date): AutoSendSlot | null {
  const { year, month, day } = manilaFields(now);
  const midnightMs = manilaMidnight(year, month, day).getTime();
  const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  for (const hour of AUTO_SEND_SLOT_HOURS) {
    const slotMs = midnightMs + hour * 60 * 60 * 1000;
    const windowStart = new Date(slotMs - WINDOW_BEFORE_MS);
    const windowEnd = new Date(slotMs + WINDOW_AFTER_MS);
    if (now >= windowStart && now <= windowEnd) {
      return { key: `${dateKey} ${slotLabel(hour)}`, windowStart, windowEnd };
    }
  }
  return null;
}

// The send log's own triggered_by value for an auto run — doubles as the
// once-per-slot marker (no separate table/column needed).
export function autoSendTriggeredBy(slot: AutoSendSlot, username: string): string {
  return `${autoSendTriggeredByPrefix(slot)} · ${username}`;
}

export function autoSendTriggeredByPrefix(slot: AutoSendSlot): string {
  return `auto ${slot.key}`;
}

// `slot` is findAutoSendSlot(now)'s own result — passed in (not recomputed)
// so the caller can look up "already sent?" for that exact slot first.
export function decideAutoSend(
  now: Date,
  slot: AutoSendSlot | null,
  lastUploads: { cashout: Date | null; sendmoney: Date | null },
  alreadySentForSlot: boolean
): AutoSendDecision {
  if (!slot) return { send: false, reason: 'outside-window', slot: null };

  const inWindow = (d: Date | null) => d !== null && d >= slot.windowStart && d <= now;
  if (!inWindow(lastUploads.cashout) && !inWindow(lastUploads.sendmoney)) {
    return { send: false, reason: 'no-upload-in-window', slot };
  }

  if (alreadySentForSlot) return { send: false, reason: 'already-sent', slot };
  return { send: true, slot };
}
