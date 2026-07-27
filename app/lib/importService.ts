// Import Service — the one module that will eventually make a real API
// call. Everything else (parser, validation engine, duplicate detector,
// summary calculator) stays exactly as-is when that happens; only this
// file's internals change from "mock progress ticks" to "a real
// request/response". Returns a cancel function so an unmount mid-import
// doesn't keep ticking against unmounted state.
export function mockImportRecords(total: number, onProgress: (done: number) => void, onComplete: () => void): () => void {
  let done = 0;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    // Uneven step size (not a perfectly linear crawl) so it reads as
    // "genuinely working through records," not a fake, mechanical timer.
    done = Math.min(total, done + Math.max(1, Math.round(total / 22)));
    onProgress(done);
    if (done >= total) {
      onComplete();
      return;
    }
    setTimeout(tick, 90 + Math.random() * 60);
  };
  setTimeout(tick, 90);
  return () => { cancelled = true; };
}
