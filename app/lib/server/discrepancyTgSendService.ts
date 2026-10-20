// Orchestrates one full "Send to TG" run: builds the plan (reusing
// Discrepancy Summary's Group Total data + Settings > Discrepancy TG's own
// rows/token/thresholds/resolveTgTarget), renders each line's photos and/or
// Full Shop List PDF, sends them in order, and writes the send log.
// Synchronous — runs inside the admin's own POST request and returns the
// full result (per the build-plan decision: no job-queue infrastructure
// exists anywhere else in this app).
import { like, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getDiscrepancySummaryRows } from '../services/discrepancySummaryService';
import { buildAllDiscrepancySummaryViews } from '../discrepancySummaryAggregate';
import { getDiscrepancyTgData } from '../services/discrepancyTgService';
import { getBalanceLimitLastImport } from '../db/read/balanceLimit';
import {
  buildSendPlan,
  MAX_PHOTOS_PER_ALBUM,
  type DiscrepancyTgSendPlan,
  type SendJob,
  type DiscrepancyTgTimestamps,
  type DiscrepancyTgThresholds,
} from '../discrepancyTgSendPlan';
import { formatTgImageTimestamp, formatBangladeshCaptionTimestamp, sanitizeFilenamePart, toTgAccountStatus } from '../discrepancyTgImageFormat';
import type { TgImagePageData } from '../discrepancyTgImageTypes';
import { bdTodayYmd, deriveLastActiveDate, formatLastActiveLabel } from '../lastActiveLabel';
import { findAutoSendSlot, decideAutoSend, autoSendTriggeredByPrefix, type AutoSendDecision } from '../discrepancyTgAutoSlot';
import type { ImagePage } from '../discrepancyTgImagePagination';
import type { DiscrepancyShopEntry } from '../discrepancySummaryAggregate';
import { launchBrowser } from './puppeteerCapture';
import { renderDiscrepancyImage } from './discrepancyTgImageRenderer';
import { renderDiscrepancyPdf } from './discrepancyTgPdfRenderer';
import { sendAlbum, sendDocument, TelegramInvalidTokenError } from './discrepancyTgTelegramClient';

// A lock older than this is assumed to be from a crashed run, not an
// in-progress one, and can be reclaimed rather than jamming the feature
// forever.
const STALE_LOCK_MINUTES = 10;

// Section 5.1's own fixed wording, including the emoji and line breaks —
// the PDF gets no caption at all, per explicit amendment (overrides the
// plan's own section 5.2).
const PHOTO_CAPTION_TEMPLATE = `⚜️ Group Wallet Discrepancy Report

👤 Leader: {LEADER}
💼 Line: {LINE}
📅 {DATE}

Please check your wallet discrepancies and either add the balance or arrange a settlement. Thank you.`;

function buildPhotoCaption(leader: string, line: 'cashout' | 'sendmoney', dataTimestamp: Date | null): string {
  const lineLabel = line === 'cashout' ? 'Cashout' : 'Send Money';
  const dateLabel = formatBangladeshCaptionTimestamp(dataTimestamp ?? new Date());
  return PHOTO_CAPTION_TEMPLATE.replace('{LEADER}', leader).replace('{LINE}', lineLabel).replace('{DATE}', dateLabel);
}

// "SHAKIL Cashout Full List.pdf" — leader then product only, per explicit
// amendment (the date/time was making the file name too long; it's already
// in the image header and the photo caption, no need to repeat it here).
function buildPdfFilename(leader: string, line: 'cashout' | 'sendmoney'): string {
  const lineLabel = line === 'cashout' ? 'Cashout' : 'Send Money';
  return `${sanitizeFilenamePart(leader)} ${lineLabel} Full List.pdf`;
}

// Last WD day per shop from stagnant_balance_tracking (per explicit
// confirmation, the "last active" source — no login-history table exists).
// No row -> null -> "Never".
async function getLastActiveDateByAgentId(): Promise<Map<number, string | null>> {
  const db = getDb();
  const rows = await db
    .select({
      agentId: schema.stagnantBalanceTracking.agentId,
      noDataStreakDays: schema.stagnantBalanceTracking.noDataStreakDays,
      lastCheckedCutoffDate: schema.stagnantBalanceTracking.lastCheckedCutoffDate,
    })
    .from(schema.stagnantBalanceTracking);
  return new Map(rows.map((r) => [r.agentId, deriveLastActiveDate(r.lastCheckedCutoffDate, r.noDataStreakDays)]));
}

async function getGroupTotalLeaders() {
  const [summaryRows, lastActiveByAgentId] = await Promise.all([getDiscrepancySummaryRows(), getLastActiveDateByAgentId()]);
  const rows = summaryRows.map((r) => ({ ...r, lastActiveDate: lastActiveByAgentId.get(r.agentId) ?? null }));
  const views = buildAllDiscrepancySummaryViews(rows);
  return views.group.leaders;
}

// Fetched once per run/preview (never per job) — "every leader in the same
// run uses the same per-line value" per explicit instruction.
async function getLineTimestamps(): Promise<DiscrepancyTgTimestamps> {
  const [cashout, sendmoney] = await Promise.all([getBalanceLimitLastImport('cashout'), getBalanceLimitLastImport('sendmoney')]);
  return {
    cashout: cashout?.completedAt ? new Date(cashout.completedAt) : null,
    sendmoney: sendmoney?.completedAt ? new Date(sendmoney.completedAt) : null,
  };
}

// Auto-send gate for Operations Overview's "Send to Telegram" (see
// discrepancyTgAutoSlot.ts for the rules). Only decides — the caller runs
// runDiscrepancyTgSend itself (in after(), so the CIH send's own response
// isn't held up by a multi-minute run). "Already sent" is read from the send
// log's own triggered_by marker; a run still in progress hasn't written its
// rows yet, but the send lock already turns a second concurrent run away.
export async function checkDiscrepancyTgAutoSend(now: Date = new Date()): Promise<AutoSendDecision> {
  const slot = findAutoSendSlot(now);
  if (!slot) return decideAutoSend(now, null, { cashout: null, sendmoney: null }, false);

  const db = getDb();
  const [timestamps, sentRows] = await Promise.all([
    getLineTimestamps(),
    db
      .select({ id: schema.discrepancyTgSendLog.id })
      .from(schema.discrepancyTgSendLog)
      .where(like(schema.discrepancyTgSendLog.triggeredBy, `${autoSendTriggeredByPrefix(slot)} ·%`))
      .limit(1),
  ]);
  return decideAutoSend(now, slot, timestamps, sentRows.length > 0);
}

export type DiscrepancyTgPreview =DiscrepancyTgSendPlan & { thresholds: DiscrepancyTgThresholds };

export async function buildDiscrepancyTgPreview(): Promise<DiscrepancyTgPreview> {
  const [leaders, tgData, timestamps] = await Promise.all([getGroupTotalLeaders(), getDiscrepancyTgData(), getLineTimestamps()]);
  const thresholds: DiscrepancyTgThresholds = { cashout: tgData.cashoutThreshold, sendmoney: tgData.sendmoneyThreshold };
  const plan = buildSendPlan(leaders, tgData.rows, timestamps, thresholds);
  return { ...plan, thresholds };
}

// Atomic conditional UPDATE — the real server-side lock (not just the UI
// disabling the button). Two concurrent admins (or two clicks) racing this
// only ever let one through: the UPDATE's WHERE clause only matches a row
// that's actually unlocked (or stale-locked), so a losing racer's UPDATE
// touches zero rows and gets told so.
async function acquireSendLock(): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MINUTES * 60 * 1000);

  const [existing] = await db.select({ id: schema.discrepancyTgConfig.id }).from(schema.discrepancyTgConfig).limit(1);
  if (!existing) {
    // No config row yet (token never saved) — create it already locked.
    await db.insert(schema.discrepancyTgConfig).values({ sendLockedAt: now });
    return true;
  }

  const result = await db
    .update(schema.discrepancyTgConfig)
    .set({ sendLockedAt: now })
    .where(sql`${schema.discrepancyTgConfig.id} = ${existing.id} AND (${schema.discrepancyTgConfig.sendLockedAt} IS NULL OR ${schema.discrepancyTgConfig.sendLockedAt} < ${staleBefore})`)
    .returning({ id: schema.discrepancyTgConfig.id });

  return result.length > 0;
}

async function releaseSendLock(): Promise<void> {
  const db = getDb();
  await db.update(schema.discrepancyTgConfig).set({ sendLockedAt: null });
}

export type DiscrepancyTgSentEntry = { leader: string; line: 'cashout' | 'sendmoney'; kind: 'photos' | 'pdf'; count: number };
export type DiscrepancyTgFailedEntry = { leader: string; line: 'cashout' | 'sendmoney'; kind: 'photos' | 'pdf'; reason: string };

export type DiscrepancyTgSendOutcome = {
  totalMessagesSent: number;
  totalGroupsSent: number; // distinct chat IDs that received at least one successful message
  // One entry per successfully sent MESSAGE (a photo album batch counts as
  // one 'photos' entry, the PDF as its own 'pdf' entry) — a line with both
  // outputs produces two entries, so the result screen can show exactly
  // what went out even when one half of a line failed and the other sent.
  sent: DiscrepancyTgSentEntry[];
  failed: DiscrepancyTgFailedEntry[];
  invalidToken: boolean;
};

function buildPhotoPageDatas(job: SendJob): TgImagePageData[] {
  const timestampText = formatTgImageTimestamp(job.dataTimestamp);
  const todayBd = bdTodayYmd();
  return job.photoPages.map((page) => toPageData(job, page, timestampText, todayBd));
}

function buildPdfPageDatas(job: SendJob): TgImagePageData[] {
  const timestampText = formatTgImageTimestamp(job.dataTimestamp);
  const todayBd = bdTodayYmd();
  return job.pdfPages.map((page) => toPageData(job, page, timestampText, todayBd));
}

function toPageData(job: SendJob, page: ImagePage<DiscrepancyShopEntry>, timestampText: string, todayBd: string): TgImagePageData {
  return {
    leader: job.leader,
    line: job.line,
    pageNumber: page.pageNumber,
    totalPages: page.totalPages,
    timestamp: timestampText,
    headerTotal: job.headerTotal,
    headerShopCount: job.headerShopCount,
    rows: page.rows.map((r) => {
      const accountStatus = toTgAccountStatus(r.row.walletStatus);
      return {
        rowNumber: r.rowNumber,
        shopName: r.row.shopName,
        companyBalance: r.row.companyBalance,
        balanceInside: r.row.balanceInside,
        agentWithdrawal: r.row.agentWithdrawal,
        accountStatus,
        lastActive: accountStatus === 'Disconnected' ? formatLastActiveLabel(r.row.lastActiveDate ?? null, todayBd) : null,
      };
    }),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export type DiscrepancyTgSendProgress = {
  sentMessages: number;
  totalMessages: number;
  // Reported right before a message starts rendering/sending — lets the UI
  // show what's actively happening during a long render (an 80+ shop PDF
  // has no incremental signal of its own otherwise), not just a frozen
  // count between ticks. Absent once the run has finished its last message.
  current?: { leader: string; line: 'cashout' | 'sendmoney'; kind: 'photos' | 'pdf' };
};

export async function runDiscrepancyTgSend(
  triggeredBy: string,
  origin: string,
  sessionToken: string | undefined,
  onProgress?: (progress: DiscrepancyTgSendProgress) => void
): Promise<DiscrepancyTgSendOutcome> {
  const locked = await acquireSendLock();
  if (!locked) throw new Error('A send is already in progress');

  const runAt = new Date();
  const db = getDb();
  const logRows: (typeof schema.discrepancyTgSendLog.$inferInsert)[] = [];
  const outcome: DiscrepancyTgSendOutcome = { totalMessagesSent: 0, totalGroupsSent: 0, sent: [], failed: [], invalidToken: false };
  const successfulChatIds = new Set<string>();

  try {
    const [leaders, tgData, timestamps] = await Promise.all([getGroupTotalLeaders(), getDiscrepancyTgData(), getLineTimestamps()]);
    if (!tgData.token) throw new Error('No TG Token saved — set it in Settings → Discrepancy TG first.');
    const token = tgData.token;
    const thresholds: DiscrepancyTgThresholds = { cashout: tgData.cashoutThreshold, sendmoney: tgData.sendmoneyThreshold };

    const plan = buildSendPlan(leaders, tgData.rows, timestamps, thresholds);
    let sentMessages = 0;
    const reportProgress = (current?: DiscrepancyTgSendProgress['current']) =>
      onProgress?.({ sentMessages, totalMessages: plan.totalMessages, current });
    reportProgress();

    const browser = await launchBrowser();
    try {
      for (const job of plan.jobs) {
        const baseLog = {
          runAt,
          triggeredBy,
          leader: job.leader,
          line: job.line,
          chatId: job.chatId,
          photosCount: job.photoPages.length,
          albumsCount: job.albumsCount,
          pdfSent: job.pdfPages.length > 0,
          shopsTotal: job.headerShopCount,
          shopsInPhotos: job.photoPages.reduce((sum, p) => sum + p.rows.length, 0),
          thresholdUsed: job.thresholdUsed,
        };

        if (job.photoPages.length > 0) {
          reportProgress({ leader: job.leader, line: job.line, kind: 'photos' });
          const caption = buildPhotoCaption(job.leader, job.line, job.dataTimestamp);

          let images: Buffer[];
          try {
            const pageDatas = buildPhotoPageDatas(job);
            // Rendered concurrently — per explicit instruction to speed up
            // sending without touching output quality; each page is an
            // independent Puppeteer tab/screenshot, nothing here depends
            // on order.
            images = await Promise.all(pageDatas.map((pd) => renderDiscrepancyImage(browser, origin, sessionToken, pd)));
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'Failed to render image.';
            outcome.failed.push({ leader: job.leader, line: job.line, kind: 'photos', reason });
            logRows.push({ ...baseLog, imageCount: 0, format: 'photos', pages: job.photoPages.length, status: 'failed', reason });
            sentMessages += job.albumsCount;
            reportProgress();
            images = [];
          }

          if (images.length > 0) {
            const albums = chunk(images, MAX_PHOTOS_PER_ALBUM);
            let succeededAlbums = 0;
            let jobFailed: string | null = null;
            for (let i = 0; i < albums.length; i++) {
              const result = await sendAlbum(token, job.chatId, albums[i], i === 0 ? caption : undefined);
              if (!result.ok) {
                jobFailed = result.error;
                break;
              }
              succeededAlbums += 1;
              sentMessages += 1;
              reportProgress();
            }

            if (jobFailed) {
              outcome.failed.push({ leader: job.leader, line: job.line, kind: 'photos', reason: jobFailed });
              logRows.push({ ...baseLog, imageCount: 0, format: 'photos', pages: job.photoPages.length, status: 'failed', reason: jobFailed });
              // Only the unattempted remainder — albums that already
              // incremented sentMessages above on their own success must
              // not be counted twice.
              sentMessages += albums.length - succeededAlbums;
              reportProgress();
            } else {
              outcome.totalMessagesSent += albums.length;
              successfulChatIds.add(job.chatId);
              outcome.sent.push({ leader: job.leader, line: job.line, kind: 'photos', count: images.length });
              logRows.push({ ...baseLog, imageCount: images.length, format: 'photos', pages: job.photoPages.length, status: 'sent', reason: null });
            }
          }
        }

        if (job.pdfPages.length > 0) {
          reportProgress({ leader: job.leader, line: job.line, kind: 'pdf' });

          let pdfBuffer: Buffer;
          try {
            const pageDatas = buildPdfPageDatas(job);
            pdfBuffer = await renderDiscrepancyPdf(browser, origin, sessionToken, pageDatas);
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'Failed to render PDF.';
            outcome.failed.push({ leader: job.leader, line: job.line, kind: 'pdf', reason });
            logRows.push({ ...baseLog, imageCount: 0, format: 'pdf', pages: job.pdfPages.length, status: 'failed', reason });
            sentMessages += 1;
            reportProgress();
            pdfBuffer = Buffer.alloc(0);
          }

          if (pdfBuffer.length > 0) {
            const filename = buildPdfFilename(job.leader, job.line);
            // No caption on the PDF message at all, per explicit amendment
            // (overrides the plan's own section 5.2).
            const result = await sendDocument(token, job.chatId, pdfBuffer, filename, undefined);
            if (!result.ok) {
              outcome.failed.push({ leader: job.leader, line: job.line, kind: 'pdf', reason: result.error });
              logRows.push({ ...baseLog, imageCount: 0, format: 'pdf', pages: job.pdfPages.length, status: 'failed', reason: result.error });
            } else {
              outcome.totalMessagesSent += 1;
              successfulChatIds.add(job.chatId);
              outcome.sent.push({ leader: job.leader, line: job.line, kind: 'pdf', count: job.pdfPages.length });
              logRows.push({ ...baseLog, imageCount: 0, format: 'pdf', pages: job.pdfPages.length, status: 'sent', reason: null });
            }
            sentMessages += 1;
            reportProgress();
          }
        }
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    if (err instanceof TelegramInvalidTokenError) {
      outcome.invalidToken = true;
    } else {
      throw err;
    }
  } finally {
    outcome.totalGroupsSent = successfulChatIds.size;
    if (logRows.length > 0) await db.insert(schema.discrepancyTgSendLog).values(logRows);
    await releaseSendLock();
  }

  return outcome;
}
