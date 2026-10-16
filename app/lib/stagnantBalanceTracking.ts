// Pure logic for the Stagnant Balances streak — no I/O, no Date.now(), so
// the increment/reset/dedup rule can be unit-tested in isolation. Called
// from importEstimatedOpeningFromUpload() (estimatedOpeningService.ts) once
// per agent, every time an Estimated Balance upload completes for either
// product.
//
// Rule: a streak of consecutive Estimated Balance uploads where this
// agent's own upload row had Withdrawal at 0 (or no row at all that upload
// — "no data" is no different from "0" for this purpose). Deposit plays no
// part in this at all, per explicit instruction (WD only, never DP). A
// non-zero Withdrawal resets the streak to 0. A second upload for the SAME
// cutoffDate (a same-day correction re-upload) is a no-op — the streak
// already reflects that business day from the first upload, so it must not
// advance twice.
export type StagnantStreakState = {
  noDataStreakDays: number;
  lastCheckedCutoffDate: string | null; // 'YYYY-MM-DD'
};

export function computeStreakUpdate(current: StagnantStreakState | null, cutoffDateStr: string, hadActivityThisUpload: boolean): StagnantStreakState {
  const currentStreak = current?.noDataStreakDays ?? 0;
  const lastChecked = current?.lastCheckedCutoffDate ?? null;

  // Already evaluated for this exact business date — leave untouched.
  if (lastChecked === cutoffDateStr) {
    return { noDataStreakDays: currentStreak, lastCheckedCutoffDate: lastChecked };
  }

  return {
    noDataStreakDays: hadActivityThisUpload ? 0 : currentStreak + 1,
    lastCheckedCutoffDate: cutoffDateStr,
  };
}
