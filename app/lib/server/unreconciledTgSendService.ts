// Orchestrates one full Unreconciled Balance "Send to TG" run — broadcast
// model (same convention file-structure as discrepancyTgSendService.ts,
// different delivery shape): builds the plan (Balance tab data + Settings >
// Unreconciled TG's own group rows/token), renders every page ONCE (not
// once per group — every configured group receives the identical image
// set), then sends each group its own copy of every album in order.
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getUnreconciledBalanceRows } from '../services/unreconciledBalanceService';
import { buildAllUnreconciledViews } from '../unreconciledBalanceAggregate';
import { getUnreconciledTgData } from '../services/unreconciledTgService';
import { getBalanceLimitLastImport } from '../db/read/balanceLimit';
import { buildUnreconciledTgSendPlan, MAX_IMAGES_PER_ALBUM, type UnreconciledTgSendPlan, type UnreconciledTgTimestamps } from '../unreconciledTgSendPlan';
import { launchBrowser } from './puppeteerCapture';
import { renderUnreconciledImage } from './unreconciledTgImageRenderer';
import { sendAlbum, TelegramInvalidTokenError } from './discrepancyTgTelegramClient';

const STALE_LOCK_MINUTES = 10;

// The plan's own fixed wording — attached to the first image of each
// group's own first album (every group's chat gets it once, at the start
// of its own sequence), never repeated on later albums for that same group.
const FIXED_CAPTION = 'Hi Team Settlement, kindly check the per-group Unreconciled Balance. Thank you.';

async function getTimestamps(): Promise<UnreconciledTgTimestamps> {
  const [cashout, sendmoney] = await Promise.all([getBalanceLimitLastImport('cashout'), getBalanceLimitLastImport('sendmoney')]);
  return {
    cashout: cashout?.completedAt ? new Date(cashout.completedAt) : null,
    sendmoney: sendmoney?.completedAt ? new Date(sendmoney.completedAt) : null,
  };
}

async function buildPlan(): Promise<{ plan: UnreconciledTgSendPlan; token: string | null }> {
  const [rows, tgData, timestamps] = await Promise.all([getUnreconciledBalanceRows(), getUnreconciledTgData(), getTimestamps()]);
  const views = buildAllUnreconciledViews(rows);
  const plan = buildUnreconciledTgSendPlan(views, tgData.rows, timestamps);
  return { plan, token: tgData.token };
}

export type UnreconciledTgPreview = {
  groups: { groupName: string; imageCount: number }[];
  totalImages: number;
  totalMessages: number;
  hasToken: boolean;
};

export async function buildUnreconciledTgPreview(): Promise<UnreconciledTgPreview> {
  const { plan, token } = await buildPlan();
  return {
    groups: plan.groups.map((g) => ({ groupName: g.groupName, imageCount: plan.totalImages })),
    totalImages: plan.totalImages,
    totalMessages: plan.totalMessages,
    hasToken: Boolean(token),
  };
}

// Same atomic conditional-UPDATE lock pattern as discrepancyTgSendService.ts,
// against this feature's own config row.
async function acquireSendLock(): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MINUTES * 60 * 1000);

  const [existing] = await db.select({ id: schema.unreconciledTgConfig.id }).from(schema.unreconciledTgConfig).limit(1);
  if (!existing) {
    await db.insert(schema.unreconciledTgConfig).values({ sendLockedAt: now });
    return true;
  }

  const result = await db
    .update(schema.unreconciledTgConfig)
    .set({ sendLockedAt: now })
    .where(
      sql`${schema.unreconciledTgConfig.id} = ${existing.id} AND (${schema.unreconciledTgConfig.sendLockedAt} IS NULL OR ${schema.unreconciledTgConfig.sendLockedAt} < ${staleBefore})`
    )
    .returning({ id: schema.unreconciledTgConfig.id });

  return result.length > 0;
}

async function releaseSendLock(): Promise<void> {
  const db = getDb();
  await db.update(schema.unreconciledTgConfig).set({ sendLockedAt: null });
}

export type UnreconciledTgSentEntry = { groupName: string; albumIndex: number; albumsTotal: number; count: number };
export type UnreconciledTgFailedEntry = { groupName: string; albumIndex: number; albumsTotal: number; reason: string };

export type UnreconciledTgSendOutcome = {
  totalMessagesSent: number;
  totalGroupsSent: number;
  sent: UnreconciledTgSentEntry[];
  failed: UnreconciledTgFailedEntry[];
  invalidToken: boolean;
};

export type UnreconciledTgSendProgress = {
  sentMessages: number;
  totalMessages: number;
  current?: { groupName: string; albumIndex: number; albumsTotal: number };
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function runUnreconciledTgSend(
  triggeredBy: string,
  origin: string,
  sessionToken: string | undefined,
  onProgress?: (progress: UnreconciledTgSendProgress) => void
): Promise<UnreconciledTgSendOutcome> {
  const locked = await acquireSendLock();
  if (!locked) throw new Error('A send is already in progress');

  const runAt = new Date();
  const db = getDb();
  const logRows: (typeof schema.unreconciledTgSendLog.$inferInsert)[] = [];
  const outcome: UnreconciledTgSendOutcome = { totalMessagesSent: 0, totalGroupsSent: 0, sent: [], failed: [], invalidToken: false };
  const successfulGroups = new Set<string>();

  try {
    const { plan, token } = await buildPlan();
    if (!token) throw new Error('No TG Token saved — set it in Settings → Unreconciled TG first.');
    if (plan.groups.length === 0) throw new Error('No groups configured — add one in Settings → Unreconciled TG first.');
    if (plan.pages.length === 0) throw new Error('Nothing to send — Unreconciled Balance has no rows right now.');

    let sentMessages = 0;
    const reportProgress = (current?: UnreconciledTgSendProgress['current']) => onProgress?.({ sentMessages, totalMessages: plan.totalMessages, current });
    reportProgress();

    const browser = await launchBrowser();
    try {
      // Rendered ONCE for the whole run — every group gets the identical
      // image set, so there's no reason to re-render per group.
      const allImages = await Promise.all(plan.pages.map((pd) => renderUnreconciledImage(browser, origin, sessionToken, pd)));
      const imageAlbums = chunk(allImages, MAX_IMAGES_PER_ALBUM);

      for (const group of plan.groups) {
        for (let i = 0; i < imageAlbums.length; i++) {
          reportProgress({ groupName: group.groupName, albumIndex: i + 1, albumsTotal: imageAlbums.length });
          const caption = i === 0 ? FIXED_CAPTION : undefined;
          const result = await sendAlbum(token, group.tgId, imageAlbums[i], caption);

          if (!result.ok) {
            outcome.failed.push({ groupName: group.groupName, albumIndex: i + 1, albumsTotal: imageAlbums.length, reason: result.error });
            logRows.push({
              runAt,
              triggeredBy,
              groupName: group.groupName,
              chatId: group.tgId,
              albumIndex: i + 1,
              albumsTotal: imageAlbums.length,
              imageCount: 0,
              status: 'failed',
              reason: result.error,
            });
          } else {
            outcome.totalMessagesSent += 1;
            successfulGroups.add(group.groupName);
            outcome.sent.push({ groupName: group.groupName, albumIndex: i + 1, albumsTotal: imageAlbums.length, count: imageAlbums[i].length });
            logRows.push({
              runAt,
              triggeredBy,
              groupName: group.groupName,
              chatId: group.tgId,
              albumIndex: i + 1,
              albumsTotal: imageAlbums.length,
              imageCount: imageAlbums[i].length,
              status: 'sent',
              reason: null,
            });
          }
          sentMessages += 1;
          reportProgress();
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
    outcome.totalGroupsSent = successfulGroups.size;
    if (logRows.length > 0) await db.insert(schema.unreconciledTgSendLog).values(logRows);
    await releaseSendLock();
  }

  return outcome;
}
