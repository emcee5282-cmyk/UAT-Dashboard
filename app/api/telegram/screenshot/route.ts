import { NextRequest, NextResponse, after } from 'next/server';
import type { Browser } from 'puppeteer-core';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/app/lib/auth/session';
import { launchBrowser, waitForRealData, captureElement } from '@/app/lib/server/puppeteerCapture';
import { checkDiscrepancyTgAutoSend, runDiscrepancyTgSend } from '@/app/lib/server/discrepancyTgSendService';
import { autoSendTriggeredBy } from '@/app/lib/discrepancyTgAutoSlot';

export const runtime = 'nodejs';
// after() runs within this same ceiling on platforms that enforce one —
// raised from 60 to the manual Discrepancy send route's own 300 so an
// auto-triggered run isn't cut short there (the self-hosted VPS has no
// per-request timeout either way).
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: 'Telegram is not configured on this deployment.' }, { status: 500 });
  }

  // The caller (whoever clicked "Send to Telegram") already has a valid
  // session — middleware.ts wouldn't have let this request reach here
  // otherwise. Puppeteer's own internal page has no cookies at all though,
  // so its navigation to the target dashboard path used to hit the login
  // redirect instead of the real page, and every capture selector then
  // failed with "Capture target not found" — confirmed live (reproduced
  // the exact Puppeteer navigation cold: it lands on /login, and
  // `[data-telegram-capture="cards"]` isn't there). Forwarding the same
  // session cookie onto the Puppeteer page below fixes this without
  // opening any new unauthenticated path — it's the literal cookie the
  // browser that clicked the button already sent.
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  let path: string;
  let label: string;
  let captures: string[];
  try {
    const body = await request.json();
    path = typeof body?.path === 'string' ? body.path : '/';
    label = typeof body?.label === 'string' && body.label ? body.label : 'Overview';
    captures = Array.isArray(body?.captures) && body.captures.length > 0
      ? body.captures.filter((s: unknown): s is string => typeof s === 'string')
      : ['[data-telegram-capture]'];
  } catch {
    path = '/';
    label = 'Overview';
    captures = ['[data-telegram-capture]'];
  }
  if (!path.startsWith('/')) path = `/${path}`;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // Higher DPI so text stays crisp when the photo is viewed at Telegram's
    // (often shrunk) mobile preview size.
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    // On IP-restricted deployments, nginx blocks every source not on the
    // allowlist — including this same box's own outbound request back to its
    // public domain. INTERNAL_BASE_URL (set only in that deployment's own
    // .env.local) routes this internal navigation straight to the local
    // Next.js server instead, bypassing nginx entirely.
    const origin = process.env.INTERNAL_BASE_URL || request.nextUrl.origin;
    if (sessionToken) {
      const originUrl = new URL(origin);
      await page.setCookie({
        name: SESSION_COOKIE_NAME,
        value: sessionToken,
        domain: originUrl.hostname,
        path: '/',
        httpOnly: true,
        secure: originUrl.protocol === 'https:',
        sameSite: 'Lax',
      });
    }
    const targetUrl = new URL(path, origin).toString();
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitForRealData(page);

    const screenshots: Buffer[] = [];
    for (const selector of captures) {
      screenshots.push(await captureElement(page, selector));
    }

    const now = new Date();
    // Formatted as two separate calls rather than one combined Intl call —
    // 'en-US' joins date+time with "at" (not a comma), so building the
    // "Month DD | HH:MM AM/PM" shape directly is more reliable than trying
    // to string-replace a separator that isn't guaranteed to be there.
    const datePart = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'Asia/Manila' }).format(now);
    const timePart = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' }).format(now);
    const caption = `<b>✅ Updated: ${label}</b>\n📅 ${datePart} | ${timePart}`;

    let telegramRes: Response;
    if (screenshots.length === 1) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([new Uint8Array(screenshots[0])], { type: 'image/png' }), 'screenshot.png');
      telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
    } else {
      // sendMediaGroup delivers every photo as one grouped album in a single
      // trigger — Telegram only surfaces the caption from the first item in
      // the group, so it's set there only.
      const media = screenshots.map((_, i) => ({
        type: 'photo',
        media: `attach://photo${i}`,
        ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
      }));
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('media', JSON.stringify(media));
      screenshots.forEach((buf, i) => {
        form.append(`photo${i}`, new Blob([new Uint8Array(buf)], { type: 'image/png' }), `screenshot${i}.png`);
      });
      telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: 'POST', body: form });
    }

    const telegramJson = await telegramRes.json();
    if (!telegramRes.ok || !telegramJson.ok) {
      const description = telegramJson?.description ?? `Telegram API returned ${telegramRes.status}`;
      return NextResponse.json({ ok: false, error: description }, { status: 502 });
    }

    // Operations Overview only (this route also serves a demo page) — a
    // successful CIH send inside a 12/3/6/9PM (GMT+8) window with a fresh
    // Balance Limit upload also fires the Discrepancy TG send, once per
    // slot (see discrepancyTgAutoSlot.ts). Anyone logged in can trigger it,
    // per explicit instruction. Runs in after() so this response returns
    // as soon as the CIH photos are out.
    let discrepancyAutoSend: { triggered: boolean; slot: string | null; reason?: string } | undefined;
    if (path === '/') {
      try {
        const decision = await checkDiscrepancyTgAutoSend();
        discrepancyAutoSend = decision.send
          ? { triggered: true, slot: decision.slot.key }
          : { triggered: false, slot: decision.slot?.key ?? null, reason: decision.reason };
        if (decision.send) {
          const session = await verifySessionToken(sessionToken);
          const triggeredBy = autoSendTriggeredBy(decision.slot, session?.username ?? 'unknown');
          after(async () => {
            try {
              const outcome = await runDiscrepancyTgSend(triggeredBy, origin, sessionToken);
              console.log(`[DiscrepancyTG auto] ${triggeredBy}: ${outcome.totalMessagesSent} messages, ${outcome.failed.length} failed${outcome.invalidToken ? ', invalid token' : ''}`);
            } catch (err) {
              // e.g. "A send is already in progress" (a manual run holding
              // the lock) — skipped, nothing to retry automatically.
              console.error(`[DiscrepancyTG auto] ${triggeredBy} not sent:`, err instanceof Error ? err.message : err);
            }
          });
        }
      } catch (err) {
        // Never fail the CIH send over the auto-send check itself.
        console.error('[DiscrepancyTG auto] check failed:', err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({ ok: true, discrepancyAutoSend });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to capture or send screenshot.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}
