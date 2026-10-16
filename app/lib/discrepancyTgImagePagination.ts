// Pure pagination for the "Send to TG" images — one leader+line's shop list
// split into pages of at most PAGE_SIZE rows, with row numbers continuing
// across pages (1-30, 31-60, ...) rather than resetting per page.
export const TG_IMAGE_PAGE_SIZE = 30;

// CSS px height of a full 30-row card — measured directly from the live v2
// template (scripts/_calibrate-tg-image-height.ts: the .card element's own
// getBoundingClientRect().height with this constant itself temporarily
// zeroed out, so the measurement reflects true natural content height, not
// a self-fulfilling floor), not guessed. Recalibrated from the pre-v2
// design's 1357 after the header/footer/table CSS was rebuilt to match
// tg-page-template.html exactly (measured 1555.25, rounded up to avoid
// sub-pixel clipping). Every photo and every PDF page's .card gets this as
// its own min-height (not just the outer wrapper's), so a short page still
// pins its footer to the very bottom instead of floating right after the
// table — see DiscrepancyTgCard's own comment.
export const TG_IMAGE_PAGE_HEIGHT_PX = 1556;

// Top+bottom padding the page.tsx wrapper puts around the .card (28px each
// side, matching the reference template's own `body{padding:28px}`).
export const TG_PAGE_PADDING_PX = 28;

// A PDF page's own physical size must contain the CARD's full height
// (TG_IMAGE_PAGE_HEIGHT_PX) PLUS the wrapper's padding around it — using
// just the card's own height here (a real bug, caught live: the card
// overflowed its box-sizing:border-box wrapper by exactly this padding
// amount, and `overflow:hidden` silently clipped the footer off the
// bottom of every full page) renders a page 56px too short.
export const TG_PDF_PAGE_HEIGHT_PX = TG_IMAGE_PAGE_HEIGHT_PX + TG_PAGE_PADDING_PX * 2;

export type NumberedRow<T> = { row: T; rowNumber: number };

export type ImagePage<T> = {
  rows: NumberedRow<T>[];
  pageNumber: number; // 1-indexed
  totalPages: number;
};

export function paginate<T>(shops: T[], pageSize: number = TG_IMAGE_PAGE_SIZE): ImagePage<T>[] {
  if (shops.length === 0) return [];
  const totalPages = Math.ceil(shops.length / pageSize);
  const pages: ImagePage<T>[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const start = (pageNumber - 1) * pageSize;
    const rows = shops.slice(start, start + pageSize).map((row, i) => ({ row, rowNumber: start + i + 1 }));
    pages.push({ rows, pageNumber, totalPages });
  }
  return pages;
}
