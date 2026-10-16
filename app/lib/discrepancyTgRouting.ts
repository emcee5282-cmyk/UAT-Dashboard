// Routing helper for the (not-yet-built) phase that sends each leader their
// Discrepancy Summary image via Telegram. This file only decides WHERE a
// given line's summary goes for one leader's group row — it sends nothing.
// Pure and deterministic: same inputs always produce the same output, no
// I/O, so the actual send step can unit-test its own logic against this in
// isolation.
export type DiscrepancyTgGroupRow = {
  tgIdCashout: string | null;
  tgIdSendmoney: string | null;
};

export type DiscrepancyTgLine = 'cashout' | 'sendmoney';

// One ID filled -> that leader has a single group, so both summaries go
// there. Both filled -> each summary goes to its own group. Neither filled
// -> skip (no UI hint for this anywhere, per explicit instruction).
export function resolveTgTarget(groupRow: DiscrepancyTgGroupRow, line: DiscrepancyTgLine): string | null {
  const cashout = groupRow.tgIdCashout?.trim() || null;
  const sendmoney = groupRow.tgIdSendmoney?.trim() || null;

  if (cashout && sendmoney) return line === 'cashout' ? cashout : sendmoney;
  if (cashout && !sendmoney) return cashout;
  if (!cashout && sendmoney) return sendmoney;
  return null;
}
