// Purely a content-layer visual — sits directly beneath a solid sticky
// header (never on the header itself) so content scrolling underneath
// fades out smoothly over ~32px instead of hard-cutting at the header's
// edge. `top-full` anchors it to the bottom edge of its positioned parent
// (the header's own sticky wrapper), so it tracks the header's real height
// automatically. pointer-events-none so it never blocks clicks on the
// content passing beneath it. `bgClassName` must match the header's own
// background exactly or the seam shows.
export default function HeaderFadeEdge({ bgClassName = 'from-background' }: { bgClassName?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b ${bgClassName} to-transparent`}
    />
  );
}
