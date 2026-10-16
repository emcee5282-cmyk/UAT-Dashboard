// One-shot "bypass balanceService.ts's own in-memory cache" signal for
// Pending Balance's Refresh button (see that file's own cache comment for
// why it exists). sessionStorage, not the URL — stays independent of the
// `?tab=` persistence page.tsx already uses, and is naturally scoped to
// this browser tab's own session.
const KEY = 'pendingBalanceForceRefresh';

// Set right before the Refresh button's own window.location.reload() — a
// hard reload wipes all JS state, so sessionStorage is the only way to
// carry this one bit across it.
export function markForceRefresh(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Private window / blocked storage — this one refresh just won't
    // force-bypass the cache, not worth failing the refresh over.
  }
}

// Reads AND clears the flag in one call — a one-shot signal, not a
// persistent setting, so a later plain reload/revisit of the same tab
// never keeps forcing forever. Only the one Tab component active at mount
// time ever calls this (the other two tabs aren't even rendered, per
// page.tsx's own conditional render), so there's no multi-consumer race.
export function consumeForceRefresh(): boolean {
  try {
    const value = sessionStorage.getItem(KEY) === '1';
    if (value) sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return false;
  }
}
