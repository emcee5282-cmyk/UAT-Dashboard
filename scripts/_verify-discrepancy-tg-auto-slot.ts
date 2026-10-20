// Verifies discrepancyTgAutoSlot.ts's window/upload/once-per-slot rules.
// Pure — no DB, no network. Run with: npx tsx scripts/_verify-discrepancy-tg-auto-slot.ts
import { findAutoSendSlot, decideAutoSend, autoSendTriggeredBy } from '../app/lib/discrepancyTgAutoSlot';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`}`);
}

// Manila (GMT+8) wall-clock -> absolute instant.
const mnl = (s: string) => new Date(`${s}+08:00`);
const none = { cashout: null, sendmoney: null };

// --- window edges, GMT+8 (not BD) ---
check('11:39 GMT+8 -> outside', findAutoSendSlot(mnl('2026-10-20T11:39:59'))?.key ?? null, null);
check('11:40 GMT+8 -> 12PM slot', findAutoSendSlot(mnl('2026-10-20T11:40:00'))?.key, '2026-10-20 12PM');
check('12:30 GMT+8 -> 12PM slot', findAutoSendSlot(mnl('2026-10-20T12:30:00'))?.key, '2026-10-20 12PM');
check('12:31 GMT+8 -> outside', findAutoSendSlot(mnl('2026-10-20T12:30:01'))?.key ?? null, null);
check('14:45 -> 3PM', findAutoSendSlot(mnl('2026-10-20T14:45:00'))?.key, '2026-10-20 3PM');
check('18:10 -> 6PM', findAutoSendSlot(mnl('2026-10-20T18:10:00'))?.key, '2026-10-20 6PM');
check('21:30 -> 9PM', findAutoSendSlot(mnl('2026-10-20T21:30:00'))?.key, '2026-10-20 9PM');
check('16:00 -> outside', findAutoSendSlot(mnl('2026-10-20T16:00:00'))?.key ?? null, null);
// 12:00 BD time = 14:00 GMT+8 — must NOT count as the 12PM slot.
check('12:00 BD (=14:00 GMT+8) -> outside, not 12PM', findAutoSendSlot(new Date('2026-10-20T12:00:00+06:00'))?.key ?? null, null);

// --- upload rules ---
{
  const now = mnl('2026-10-20T12:05:00');
  const slot = findAutoSendSlot(now);
  check('in window, no uploads -> skip', decideAutoSend(now, slot, none, false).send, false);
  check('reason no-upload-in-window', (decideAutoSend(now, slot, none, false) as { reason: string }).reason, 'no-upload-in-window');
  check('upload 11:39 (before window) -> skip', decideAutoSend(now, slot, { cashout: mnl('2026-10-20T11:39:00'), sendmoney: null }, false).send, false);
  check('only cashout uploaded 11:45 -> send (both products go out)', decideAutoSend(now, slot, { cashout: mnl('2026-10-20T11:45:00'), sendmoney: mnl('2026-10-20T09:00:00') }, false).send, true);
  check('only sendmoney uploaded 12:01 -> send', decideAutoSend(now, slot, { cashout: null, sendmoney: mnl('2026-10-20T12:01:00') }, false).send, true);
  check('both uploaded -> send', decideAutoSend(now, slot, { cashout: mnl('2026-10-20T11:50:00'), sendmoney: mnl('2026-10-20T11:55:00') }, false).send, true);
  check('already sent this slot -> skip', (decideAutoSend(now, slot, { cashout: mnl('2026-10-20T11:50:00'), sendmoney: null }, true) as { reason: string }).reason, 'already-sent');
}
{
  const now = mnl('2026-10-20T16:00:00');
  check('outside window -> skip even with fresh upload', (decideAutoSend(now, findAutoSendSlot(now), { cashout: mnl('2026-10-20T15:59:00'), sendmoney: null }, false) as { reason: string }).reason, 'outside-window');
}

// --- once-per-slot marker is per date+slot ---
{
  const a = findAutoSendSlot(mnl('2026-10-20T12:00:00'))!;
  const b = findAutoSendSlot(mnl('2026-10-21T12:00:00'))!;
  check('triggered_by marker', autoSendTriggeredBy(a, 'jayd'), 'auto 2026-10-20 12PM · jayd');
  check('next day same slot has a different key', a.key === b.key, false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
