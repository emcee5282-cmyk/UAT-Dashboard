// Pure planning logic for "Send to TG" — decides WHO gets WHAT, reusing the
// Discrepancy Summary tab's own Group Total data and Settings > Discrepancy
// TG's own resolveTgTarget() routing rules (no re-implementation of either).
// No I/O here: this only takes already-fetched data and returns a plan: a
// per-leader preview (same shape the confirmation pop-up renders) plus the
// ready-to-send jobs (one per leader+line that actually has somewhere to
// go). The preview and the real send both read from this SAME output, so
// they can't drift apart — per explicit instruction ("the preview matches
// exactly what will be sent").
//
// Send to TG v2 rules (per leader, per line — Cashout then Send Money):
// "shops" = that line's positive (Agent Withdrawal > 0) shops from Group
// Total; "above" = the shops at/above that line's own threshold.
//   shops = 0                      -> nothing
//   shops > 0, above = 0           -> Full Shop List PDF only (all shops)
//   above >= 1                     -> all photos (no max) + the PDF
// (The old "1 photo only, no PDF" case for 1-30 above shops is gone — per
// explicit instruction, the PDF now always goes out, however few shops are
// above the threshold.)
// The PDF, when sent, always contains ALL shops (above and below the
// threshold) — never just the photo shops. Telegram caps one album at 10
// photos, so a photo page count above 10 splits into multiple albums; that
// split is a send-time/counting detail (albumsCount below), not a planning
// decision — the shops themselves are never re-split by this module.
import { paginate, type ImagePage } from './discrepancyTgImagePagination';
import { resolveTgTarget, type DiscrepancyTgLine } from './discrepancyTgRouting';
import type { DiscrepancyLeaderGroup, DiscrepancyShopEntry } from './discrepancySummaryAggregate';

export type DiscrepancyTgRowLike = {
  groupName: string;
  tgIdCashout: string | null;
  tgIdSendmoney: string | null;
};

export type DiscrepancyTgThresholds = {
  cashout: number;
  sendmoney: number;
};

// Telegram's sendMediaGroup caps one album at 10 photos — exported so the
// send service reuses the exact same number when it actually chunks
// photoPages into albums, instead of a second hardcoded copy drifting from
// this one.
export const MAX_PHOTOS_PER_ALBUM = 10;

export type LineOutcomeKind = 'none' | 'pdfOnly' | 'photosAndPdf';

export type LineOutcome = {
  kind: LineOutcomeKind;
  aboveCount: number; // shops at/above the threshold (0 for 'none'/'pdfOnly')
  totalCount: number; // all positive shops on this line (0 for 'none')
  photoPageCount: number; // ceil(aboveCount / 30) — how many photos, not albums
  albumsCount: number; // ceil(photoPageCount / 10), 0 if no photos
  pdfSent: boolean;
  messagesCount: number; // albumsCount + (pdfSent ? 1 : 0) — what "Send N messages" counts
  routedTo: 'own' | 'other'; // 'other' = fell back to the other line's id (the "same group" case)
};

export type LeaderSendPreview = {
  leader: string;
  cashout: LineOutcome;
  sendmoney: LineOutcome;
};

// Per-line source timestamp for the Balance tab's own last upload — a real
// Date (the DB's completed_at instant) or null when that line has never
// had one. Supplied by the caller (this module stays I/O-free, per its own
// header comment) so the same two instants are reused for every leader in
// one run, not re-fetched per job.
export type DiscrepancyTgTimestamps = {
  cashout: Date | null;
  sendmoney: Date | null;
};

export type SendJob = {
  leader: string;
  line: DiscrepancyTgLine;
  chatId: string;
  // Above-threshold shops only, 30/page — empty when this line sends no
  // photos ('none' or 'pdfOnly').
  photoPages: ImagePage<DiscrepancyShopEntry>[];
  // ceil(photoPages.length / MAX_PHOTOS_PER_ALBUM) — carried here (not
  // just derivable by the caller) so the send service and the send log
  // both use this exact same number rather than a second computation that
  // could drift from it.
  albumsCount: number;
  // ALL positive shops, above and below the threshold, 30/page — empty
  // only when this line sends nothing ('none').
  pdfPages: ImagePage<DiscrepancyShopEntry>[];
  // The header's "TOTAL GROUP DISCREPANCY" + "{N} shops" — sum/count over
  // ALL of this line's positive shops, identical on every photo AND PDF
  // page this job renders (never just the above-threshold subset).
  headerTotal: number;
  headerShopCount: number;
  thresholdUsed: number;
  // This job's own line's Balance tab last-upload instant (null = no
  // upload yet, rendered as "Last update: —").
  dataTimestamp: Date | null;
  messagesCount: number;
};

export type DiscrepancyTgSendPlan = {
  leaders: LeaderSendPreview[];
  jobs: SendJob[];
  // Each album counts as one message, each PDF counts as one message —
  // section 6.1's own "Send {M} messages" count, summed across every job.
  totalMessages: number;
};

function buildLineResult(
  leader: string,
  line: DiscrepancyTgLine,
  shops: DiscrepancyShopEntry[], // already-positive, already sorted largest-first (Group Total's own contract)
  threshold: number,
  tgRow: DiscrepancyTgRowLike,
  timestamps: DiscrepancyTgTimestamps
): { outcome: LineOutcome; job: SendJob | null } {
  const totalCount = shops.length;
  if (totalCount === 0) {
    return {
      outcome: { kind: 'none', aboveCount: 0, totalCount: 0, photoPageCount: 0, albumsCount: 0, pdfSent: false, messagesCount: 0, routedTo: 'own' },
      job: null,
    };
  }

  // Never null here — the caller only ever passes a tgRow that already has
  // at least one non-blank id (see buildSendPlan's own filter), and
  // resolveTgTarget only returns null when BOTH ids are blank.
  const chatId = resolveTgTarget(tgRow, line)!;
  const ownId = (line === 'cashout' ? tgRow.tgIdCashout : tgRow.tgIdSendmoney)?.trim() || null;
  const routedTo: 'own' | 'other' = chatId === ownId ? 'own' : 'other';

  const above = shops.filter((s) => s.agentWithdrawal >= threshold);
  const headerTotal = shops.reduce((sum, s) => sum + s.agentWithdrawal, 0);

  const photoPages = above.length > 0 ? paginate(above) : [];
  const albumsCount = Math.ceil(photoPages.length / MAX_PHOTOS_PER_ALBUM);

  const kind: LineOutcomeKind = above.length === 0 ? 'pdfOnly' : 'photosAndPdf';
  const pdfPages = paginate(shops);

  const pdfSent = pdfPages.length > 0;
  const messagesCount = albumsCount + (pdfSent ? 1 : 0);

  return {
    outcome: { kind, aboveCount: above.length, totalCount, photoPageCount: photoPages.length, albumsCount, pdfSent, messagesCount, routedTo },
    job: {
      leader,
      line,
      chatId,
      photoPages,
      albumsCount,
      pdfPages,
      headerTotal,
      headerShopCount: totalCount,
      thresholdUsed: threshold,
      dataTimestamp: timestamps[line],
      messagesCount,
    },
  };
}

// Iterates the TG CONFIG rows, not Group Total's leader list — per explicit
// instruction, only a leader actually configured with at least one real TG
// id in Settings > Discrepancy TG is ever considered here. A leader Group
// Total knows about but nobody configured for TG delivery must never
// appear in the preview or result, not even as a "skipped" row — there is
// nothing to validate or display for them. A configured row with both ids
// blank (saved with just a name, no ids) is excluded the same way a row
// that doesn't exist at all would be.
export function buildSendPlan(
  groupTotalLeaders: DiscrepancyLeaderGroup[],
  tgRows: DiscrepancyTgRowLike[],
  timestamps: DiscrepancyTgTimestamps,
  thresholds: DiscrepancyTgThresholds
): DiscrepancyTgSendPlan {
  const leaders: LeaderSendPreview[] = [];
  const jobs: SendJob[] = [];

  const configuredRows = tgRows.filter((r) => r.tgIdCashout?.trim() || r.tgIdSendmoney?.trim());

  for (const tgRow of configuredRows) {
    const key = tgRow.groupName.trim().toUpperCase();
    const leaderGroup = groupTotalLeaders.find((l) => l.leader.trim().toUpperCase() === key);
    if (!leaderGroup || !leaderGroup.hasIncludedShops) continue; // nothing to send this run

    const cashoutShops = leaderGroup.shops.filter((s) => s.line === 'cashout');
    const sendmoneyShops = leaderGroup.shops.filter((s) => s.line === 'sendmoney');

    const cashoutResult = buildLineResult(leaderGroup.leader, 'cashout', cashoutShops, thresholds.cashout, tgRow, timestamps);
    const sendmoneyResult = buildLineResult(leaderGroup.leader, 'sendmoney', sendmoneyShops, thresholds.sendmoney, tgRow, timestamps);

    leaders.push({ leader: leaderGroup.leader, cashout: cashoutResult.outcome, sendmoney: sendmoneyResult.outcome });
    // Cashout before Send Money when both go out, per explicit order rule
    // (section 2.4) — within each, photos always precede that line's own
    // PDF, which the send loop itself enforces (both live on the same job).
    if (cashoutResult.job) jobs.push(cashoutResult.job);
    if (sendmoneyResult.job) jobs.push(sendmoneyResult.job);
  }

  const totalMessages = jobs.reduce((sum, j) => sum + j.messagesCount, 0);
  return { leaders, jobs, totalMessages };
}
