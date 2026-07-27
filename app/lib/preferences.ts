// Generic localStorage-backed preference helper — the same persistence
// strategy Sidebar has always used for its own panel-open state, extracted
// so any page/feature needing "remember this choice across a refresh"
// doesn't hand-roll its own read/write/try-catch. Settlement's Column
// Visibility (Enterprise Table V2) is the first consumer; a future Saved
// Views feature is expected to build on the same primitive.

// SSR-safe: Next.js can evaluate client components' module scope during
// server rendering, where `localStorage` doesn't exist — every function
// below no-ops (get* returns the fallback) rather than throwing.
const hasLocalStorage = typeof window !== 'undefined';

export function getPreference<T>(key: string, fallback: T): T {
  if (!hasLocalStorage) return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Malformed/stale value (e.g. hand-edited or from a since-changed
    // shape) — treat exactly like "nothing saved" rather than throwing.
    return fallback;
  }
}

export function setPreference<T>(key: string, value: T): void {
  if (!hasLocalStorage) return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function removePreference(key: string): void {
  if (!hasLocalStorage) return;
  localStorage.removeItem(key);
}

// Distinct from removePreference: writes a known default value explicitly
// (e.g. for a "Restore Defaults" action), rather than clearing the key
// entirely. Behaviorally similar to setPreference, but named for its own
// call-site intent so a reader doesn't have to infer "reset" from a bare
// "set".
export function resetPreference<T>(key: string, defaultValue: T): void {
  setPreference(key, defaultValue);
}
