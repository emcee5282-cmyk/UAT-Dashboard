// Pure planning logic for Unreconciled Balance's "Send to TG" — a broadcast
// model (unlike Discrepancy TG's per-leader routing): every configured
// group gets the exact same image sequence — Cashout pages, then Send
// Money pages, then Group Total pages, each view's own 30-leader-rows-per-
// image pagination, Total row only on each view's own last page — chunked
// into albums of at most 10 images REGARDLESS of view boundaries (an album
// can straddle the Cashout/Send Money seam). No I/O here: takes
// already-aggregated views + already-fetched group rows + timestamps, and
// returns the same plan both the preview and the real send consume, so
// they can't drift apart.
import { paginate, type ImagePage, UNRECONCILED_TG_LINE_IMAGE_PAGE_SIZE, UNRECONCILED_TG_GROUP_IMAGE_PAGE_SIZE } from './unreconciledTgImagePagination';
import { formatTgImageTimestamp } from './discrepancyTgImageFormat';
import type { UnreconciledAllViews, UnreconciledLeaderRow } from './unreconciledBalanceAggregate';
import { sumUnreconciledRows } from './unreconciledBalanceAggregate';
import type { UnreconciledTgImagePageData, UnreconciledTgView } from './unreconciledTgImageTypes';

// Telegram's sendMediaGroup caps one album at 10 photos — same constant the
// Discrepancy TG send plan exports, duplicated here since this plan's own
// chunking is independent (album boundaries aren't tied to view boundaries
// the way Discrepancy TG's are tied to leader/line boundaries).
export const MAX_IMAGES_PER_ALBUM = 10;

export type UnreconciledTgGroupRow = { groupName: string; tgId: string };

export type UnreconciledTgTimestamps = {
  cashout: Date | null;
  sendmoney: Date | null;
};

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

const VIEW_ORDER: UnreconciledTgView[] = ['cashout', 'sendmoney', 'group'];

// Cashout and Send Money paginate at 20 leaders/image; Group Total (the
// combined/overall view) paginates at 30/image, per explicit instruction.
const PAGE_SIZE_BY_VIEW: Record<UnreconciledTgView, number> = {
  cashout: UNRECONCILED_TG_LINE_IMAGE_PAGE_SIZE,
  sendmoney: UNRECONCILED_TG_LINE_IMAGE_PAGE_SIZE,
  group: UNRECONCILED_TG_GROUP_IMAGE_PAGE_SIZE,
};

function buildViewPages(view: UnreconciledTgView, leaders: UnreconciledLeaderRow[], timestamp: Date | null): UnreconciledTgImagePageData[] {
  if (leaders.length === 0) return [];
  const timestampText = formatTgImageTimestamp(timestamp);
  const pages = paginate(leaders, PAGE_SIZE_BY_VIEW[view]);
  const totals = sumUnreconciledRows(leaders);

  return pages.map((page: ImagePage<UnreconciledLeaderRow>) => ({
    view,
    pageNumber: page.pageNumber,
    totalPages: page.totalPages,
    timestamp: timestampText,
    rows: page.rows.map((r) => ({
      rowNumber: r.rowNumber,
      leader: r.row.leader,
      companyBalance: r.row.companyBalance,
      balanceInside: r.row.balanceInside,
      agentWithdrawal: r.row.agentWithdrawal,
      sdp: r.row.sdp,
      withheld: r.row.sdpVsBalance,
    })),
    // Only the view's own last page carries the Total row.
    ...(page.pageNumber === page.totalPages
      ? { totals: { companyBalance: totals.companyBalance, balanceInside: totals.balanceInside, agentWithdrawal: totals.agentWithdrawal, sdp: totals.sdp, withheld: totals.sdpVsBalance } }
      : {}),
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export type UnreconciledTgSendPlan = {
  pages: UnreconciledTgImagePageData[];
  albums: UnreconciledTgImagePageData[][];
  totalImages: number;
  groups: UnreconciledTgGroupRow[];
  // albums.length x groups.length — every configured group receives every
  // album, per the broadcast model.
  totalMessages: number;
};

export function buildUnreconciledTgSendPlan(
  views: UnreconciledAllViews,
  groupRows: UnreconciledTgGroupRow[],
  timestamps: UnreconciledTgTimestamps
): UnreconciledTgSendPlan {
  const groupTimestamp = laterOf(timestamps.cashout, timestamps.sendmoney);
  const perViewTimestamp: Record<UnreconciledTgView, Date | null> = {
    cashout: timestamps.cashout,
    sendmoney: timestamps.sendmoney,
    group: groupTimestamp,
  };

  const pages: UnreconciledTgImagePageData[] = [];
  for (const view of VIEW_ORDER) {
    pages.push(...buildViewPages(view, views[view], perViewTimestamp[view]));
  }

  const albums = chunk(pages, MAX_IMAGES_PER_ALBUM);
  // Only groups with a non-blank TG ID actually receive anything — a saved
  // row with a name but no ID yet is excluded the same way a row that
  // doesn't exist at all would be.
  const groups = groupRows.filter((g) => g.tgId.trim());

  return { pages, albums, totalImages: pages.length, groups, totalMessages: albums.length * groups.length };
}
