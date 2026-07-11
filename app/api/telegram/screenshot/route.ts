import { NextRequest, NextResponse } from 'next/server';
import type { Browser, Page } from 'puppeteer-core';

export const runtime = 'nodejs';
export const maxDuration = 60;

// puppeteer / puppeteer-core / @sparticuz/chromium are pure-ESM packages
// (webpack's build error confirms it explicitly: "ESM packages need to be
// imported. Use 'import'") — require() can never load them correctly, so
// dynamic `await import()` is the only valid way to load them, not
// createRequire(). (That was tried: Turbopack's own dynamic-import handling
// had a separate, real bug — a broken hash-suffixed module reference — but
// switching to require() masked it behind an even more confusing silent
// failure, an empty stub object, since require() genuinely cannot load an
// ESM module. Building with webpack instead of Turbopack, which handles
// this import() correctly, is the fix.)
//
// Neither Vercel's serverless functions nor the self-hosted Linux VPS have a
// system Chromium, so both use puppeteer-core + @sparticuz/chromium's
// portable binary. `puppeteer` (with its own bundled, cross-platform
// Chromium) is a devDependency used only for local Windows/Mac dev.
//
// This must branch on a process.env.* var, not process.platform: builds are
// always produced on the local Windows dev machine (per the VPS deploy
// workflow — "the VPS never runs a build"), and process.platform has been
// observed getting frozen to the BUILD machine's OS rather than staying a
// live runtime check under this bundler. IS_LOCAL_DEV is only ever set in
// this machine's own .env.local (gitignored, never deployed), so its
// absence is what every deployed target shares.
async function launchBrowser(): Promise<Browser> {
  if (!process.env.IS_LOCAL_DEV) {
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = await import('puppeteer-core');
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const puppeteer = await import('puppeteer');
  return puppeteer.launch({ headless: true }) as unknown as Promise<Browser>;
}

// Data on these pages loads client-side after mount, so networkidle0 alone
// can still land mid-shimmer. Poll for the loading skeleton's animate-pulse
// markers to clear before screenshotting, bounded so a stuck fetch can't
// hang the request past maxDuration.
async function waitForRealData(page: Page): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const stillLoading = await page.evaluate(() => document.querySelectorAll('.animate-pulse').length > 0);
    if (!stillLoading) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Wraps the element matching `selector` in a throwaway frame div (this
// mutation only exists in this disposable Puppeteer page, never the live
// site) so the export has outer padding + a soft rounded border instead of
// sitting flush against the image edges, screenshots just that frame, then
// tears the frame down again so the next selector (if any) doesn't inherit
// a stale, overlapping fixed-position wrapper.
async function captureElement(page: Page, selector: string): Promise<Buffer> {
  const found = await page.evaluate((sel) => !!document.querySelector(sel), selector);
  if (!found) {
    throw new Error(`Capture target not found on this page — ${selector} is missing.`);
  }

  // The target's rendered width is locked as an explicit pixel value before
  // detaching it from its flex row — otherwise its flex-1 / calc() width
  // classes would go stale once it's moved. The wrapper itself is appended
  // to <body> as position:fixed rather than left in place: a right-rail
  // sibling on some pages is `absolute right-0`, so simply growing the
  // wrapper in-flow overlapped it (confirmed by inspecting the captured
  // PNG's actual pixels). Fully detaching into an isolated, topmost layer
  // guarantees nothing else can paint over the frame.
  await page.evaluate((sel) => {
    const target = document.querySelector(sel) as HTMLElement;
    const width = target.getBoundingClientRect().width;
    const isDark = document.documentElement.classList.contains('dark');
    // --product-accent etc. are scoped via a [data-product] attribute
    // selector on an ancestor (AppShell) — detaching into <body> falls
    // outside that ancestor, so those custom properties silently resolve
    // to nothing and bars/dots fall back to black. Re-declaring the same
    // attribute directly on the wrapper re-establishes them.
    const productAttr = document.querySelector('[data-product]')?.getAttribute('data-product');
    target.style.width = `${width}px`;
    target.style.flex = 'none';

    const wrapper = document.createElement('div');
    wrapper.id = '__telegram_capture_wrapper__';
    if (productAttr) wrapper.setAttribute('data-product', productAttr);
    wrapper.style.position = 'fixed';
    wrapper.style.top = '0';
    wrapper.style.left = '0';
    wrapper.style.zIndex = '2147483647';
    wrapper.style.display = 'inline-block';
    wrapper.style.padding = '24px';
    wrapper.style.background = isDark ? '#1c1c1e' : '#ffffff';
    wrapper.style.border = `1px solid ${isDark ? '#3a3a3d' : '#e5e5e7'}`;
    wrapper.style.borderRadius = '16px';

    document.body.appendChild(wrapper);
    wrapper.appendChild(target);
  }, selector);

  const wrapperEl = await page.$('#__telegram_capture_wrapper__');
  if (!wrapperEl) {
    throw new Error(`Failed to build the capture frame for ${selector}.`);
  }
  const screenshot = await wrapperEl.screenshot({ type: 'png' });

  // Tear the frame down before the next selector is processed — otherwise a
  // second position:fixed, top:0/left:0 wrapper would paint directly over
  // this one instead of occupying its own space in the document.
  await page.evaluate(() => document.getElementById('__telegram_capture_wrapper__')?.remove());

  return Buffer.from(screenshot);
}

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: 'Telegram is not configured on this deployment.' }, { status: 500 });
  }

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

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to capture or send screenshot.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}
