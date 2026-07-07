import { NextRequest, NextResponse } from 'next/server';
import type { Browser, Page } from 'puppeteer-core';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Vercel serverless has no system Chromium, so production uses
// puppeteer-core + @sparticuz/chromium's Lambda-compatible binary. Locally
// (Windows/Mac dev) that binary won't run at all, so dev instead launches
// the full `puppeteer` package's own bundled, cross-platform Chromium.
async function launchBrowser(): Promise<Browser> {
  if (process.env.VERCEL) {
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

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: 'Telegram is not configured on this deployment.' }, { status: 500 });
  }

  let path: string;
  let label: string;
  try {
    const body = await request.json();
    path = typeof body?.path === 'string' ? body.path : '/';
    label = typeof body?.label === 'string' && body.label ? body.label : 'Overview';
  } catch {
    path = '/';
    label = 'Overview';
  }
  if (!path.startsWith('/')) path = `/${path}`;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // Higher DPI so text stays crisp when the photo is viewed at Telegram's
    // (often shrunk) mobile preview size.
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    const targetUrl = new URL(path, request.nextUrl.origin).toString();
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitForRealData(page);

    // Scope the capture to the main content column (KPI cards, trend chart,
    // Wallet Summary) via a dedicated data attribute, deliberately excluding
    // the right rail (Top Performer Wallet + High Volume Agents) — an
    // element-scoped screenshot rather than a full-page one.
    const found = await page.evaluate((selector) => !!document.querySelector(selector), '[data-telegram-capture]');
    if (!found) {
      throw new Error('Capture target not found on this page — data-telegram-capture is missing.');
    }

    // Wrap the target in a throwaway frame div (this mutation only exists in
    // this disposable Puppeteer page, never the live site) so the export has
    // outer padding + a soft rounded border instead of cards sitting flush
    // against the image edges. The target's rendered width is locked as an
    // explicit pixel value before detaching it from its flex row — otherwise
    // its flex-1 / calc() width classes would go stale once it's moved.
    // The wrapper itself is appended to <body> as position:fixed rather than
    // left in place: the right rail sibling is `absolute right-0`, so simply
    // growing the wrapper in-flow overlapped it (it's later in the DOM, so
    // it painted over part of the wrapper — confirmed by inspecting the
    // captured PNG's actual pixels). Fully detaching into an isolated,
    // topmost layer guarantees nothing else can paint over the frame.
    await page.evaluate((selector) => {
      const target = document.querySelector(selector) as HTMLElement;
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
    }, '[data-telegram-capture]');

    const wrapperEl = await page.$('#__telegram_capture_wrapper__');
    if (!wrapperEl) {
      throw new Error('Failed to build the capture frame.');
    }
    const screenshot = await wrapperEl.screenshot({ type: 'png' });

    const now = new Date();
    // Formatted as two separate calls rather than one combined Intl call —
    // 'en-US' joins date+time with "at" (not a comma), so building the
    // "Month DD | HH:MM AM/PM" shape directly is more reliable than trying
    // to string-replace a separator that isn't guaranteed to be there.
    const datePart = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'Asia/Manila' }).format(now);
    const timePart = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' }).format(now);
    const caption = `<b>✅ Updated ${label}</b>\n📅 ${datePart} | ${timePart}`;

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([Buffer.from(screenshot)], { type: 'image/png' }), 'screenshot.png');

    const telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
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
