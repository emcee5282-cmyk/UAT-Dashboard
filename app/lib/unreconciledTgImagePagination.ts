// Pagination for Unreconciled Balance's "Send to TG" images — reuses the
// generic paginate()/ImagePage<T> helper from discrepancyTgImagePagination
// (it takes no Discrepancy-specific shape, just T[] + a page size), rather
// than duplicating that logic here.
export { paginate, type ImagePage, type NumberedRow } from './discrepancyTgImagePagination';

// Cashout and Send Money paginate at 25 leaders/image; Group Total — the
// combined/overall view — paginates at 30/image.
export const UNRECONCILED_TG_LINE_IMAGE_PAGE_SIZE = 25;
export const UNRECONCILED_TG_GROUP_IMAGE_PAGE_SIZE = 30;

// CSS px height of a full 30-row card for the Unreconciled TG image
// template — this feature's own design (steel-blue header, dotted grid,
// gold underline — see UnreconciledTgCard.tsx), separate from Discrepancy
// TG's own 1556px card. Live-measured via a standalone static render of
// UnreconciledTgCard with 30 rows + a Total row (.card's own
// getBoundingClientRect().height, no min-height applied) — 1204px, rounded
// up slightly for safety margin, same method as
// scripts/_calibrate-tg-image-height.ts used for Discrepancy TG's own
// constant. Used as every page's own min-height regardless of view — a
// 20-row Cashout/Send Money page is naturally shorter, so it gets padded up
// to this same height by the card's own `.grow` spacer, keeping every photo
// in an album (which can straddle view boundaries) a uniform size.
export const UNRECONCILED_TG_IMAGE_PAGE_HEIGHT_PX = 1210;

export const UNRECONCILED_TG_PAGE_PADDING_PX = 28;
