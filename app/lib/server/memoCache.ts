// Tiny generic in-memory cache: in-flight PROMISE dedup + a short TTL result
// cache, keyed by an arbitrary string. Built for balanceService.ts's own
// getAgentBalances()/getAgentBalancesForBalancePage() (profiled at
// 0.7-2.3s each, independently recomputed by every Pending Balance tab —
// see that file's own comment for the numbers), but kept generic/IO-free so
// another expensive, frequently-repeated read could reuse it later.
//
// Only effective on a long-running Node process (this app's VPS deploy) —
// a serverless/cold-start environment starts each invocation with an empty
// cache, so it degrades to "no cache" there rather than being incorrect.
type CacheEntry<T> = { value: T; expiresAt: number };

export class MemoCache<T> {
  private inFlight = new Map<string, Promise<T>>();
  private results = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number) {}

  // `force` skips reading any cached/in-flight value for this key (a true
  // bypass, for the Refresh button), but still registers its own in-flight
  // promise so two concurrent forced calls for the same key dedup with
  // each other instead of each running the full query twice.
  async get(key: string, compute: () => Promise<T>, force = false): Promise<T> {
    if (!force) {
      const cached = this.results.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }

    const promise = compute()
      .then((value) => {
        this.results.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        this.inFlight.delete(key);
        return value;
      })
      .catch((err) => {
        this.inFlight.delete(key);
        throw err;
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  // No predicate = clear everything. A predicate narrows invalidation to
  // keys matching it (e.g. "starts with this product") — not needed yet
  // (every write path here invalidates the whole cache, since there's no
  // cheap way to know which product(s) a given write touched in every
  // caller), but kept so a future caller can narrow it without changing
  // this class's own shape.
  invalidate(predicate?: (key: string) => boolean): void {
    if (!predicate) {
      this.results.clear();
      this.inFlight.clear();
      return;
    }
    for (const k of Array.from(this.results.keys())) if (predicate(k)) this.results.delete(k);
    for (const k of Array.from(this.inFlight.keys())) if (predicate(k)) this.inFlight.delete(k);
  }
}
