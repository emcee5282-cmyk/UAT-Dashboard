'use client';

type TableLoadingSpinnerProps = {
  // In-flow mode (default): reserves the table body's approximate real
  // height (row count × row height + any header/footer chrome the caller
  // already accounts for) so swapping in real rows once loaded doesn't
  // visibly jump the page. Required unless `overlay` is set.
  minHeight?: number;
  // Overlay mode — renders as `position: absolute; inset: 0` instead of an
  // in-flow block, so it centers on whatever `position: relative` container
  // the caller wraps it in (typically the table's outer, non-scrolling
  // wrapper), NOT on the table's own (possibly horizontally-scrollable,
  // possibly overflowing) content width. Centering on content instead of
  // the container was a real bug: a wide table with many columns still
  // renders every column while loading (even though overflow is clipped),
  // so a spinner centered via flex inside the table's own row/cell ends up
  // centered on that wide, mostly-offscreen content box — visually pinned
  // to one side of the visible area instead of the middle of what the user
  // can actually see. The caller is responsible for the wrapper being
  // `position: relative` and for not rendering table rows underneath while
  // loading (an empty tbody is fine — the header stays visible above this
  // overlay).
  overlay?: boolean;
  label?: string;
};

// Universal "table is loading" placeholder — blank body + centered spinner,
// no skeleton rows. Pairs with the `dt-row-stagger-in` CSS class
// (app/globals.css) applied to real rows once they render.
//
// Spinner is the mockup's own plain CSS circle (border + border-top-color,
// spin), NOT a Lucide icon. Colors mapped to this app's own universal
// tokens: --border for the ring, --ui-accent (the non-product-scoped
// indigo/gold token, not --product-accent, so this never picks up Send
// Money's teal) for the spinning top edge.
//
// role="status" + aria-live="polite" announces "Loading data" to screen
// readers the moment this mounts (standard accessible-spinner pattern) —
// there's no matching "data updated" announcement on unmount, since
// role="status" content is meant to announce on appearance, not removal;
// the real rows becoming visible/focusable is the completion signal.
export default function TableLoadingSpinner({ minHeight, overlay = false, label = 'Loading data' }: TableLoadingSpinnerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={overlay ? 'absolute inset-0 flex items-center justify-center' : 'flex w-full items-center justify-center'}
      style={overlay ? undefined : { minHeight }}
    >
      <div
        aria-hidden="true"
        className="dt-table-spinner"
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '2px solid var(--border)',
          borderTopColor: 'var(--ui-accent)',
        }}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
