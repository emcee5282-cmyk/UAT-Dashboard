// Renders one Unreconciled Balance TG image page to a PNG buffer by
// navigating a shared Puppeteer browser to app/internal/unreconciled-tg-
// image — same convention as discrepancyTgImageRenderer.ts (screenshotting
// the real Next.js page gets Inter "for free" through the app's own root
// layout).
import type { Browser } from 'puppeteer-core';
import { SESSION_COOKIE_NAME } from '../auth/session';
import type { UnreconciledTgImagePageData } from '../unreconciledTgImageTypes';

function base64UrlEncode(json: string): string {
  return Buffer.from(json, 'utf-8').toString('base64url');
}

// 1100px CSS width, device scale 2 -> 2200px PNG, same spec as the
// Discrepancy TG image. Height is whatever the content needs — fullPage
// screenshot, not a fixed viewport height.
export async function renderUnreconciledImage(
  browser: Browser,
  origin: string,
  sessionToken: string | undefined,
  pageData: UnreconciledTgImagePageData
): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });

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

    const encoded = base64UrlEncode(JSON.stringify(pageData));
    const url = new URL('/internal/unreconciled-tg-image', origin);
    url.searchParams.set('data', encoded);

    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('[data-tg-image-ready="true"]', { timeout: 10000 });

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
}
