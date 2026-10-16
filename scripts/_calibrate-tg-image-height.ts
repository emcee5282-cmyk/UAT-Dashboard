// One-off calibration: measures the live Discrepancy TG image template's
// natural rendered height at exactly 30 rows (the maximum page size) — that
// height IS the "full page" target every photo/PDF page must be locked to,
// since 30 rows is already the tallest a page ever gets. Read-only against
// a local dev server; renders nothing a real user would ever see.
// Run with: npx tsx --env-file=.env.local scripts/_calibrate-tg-image-height.ts
import { createSessionToken } from '../app/lib/auth/session';
import { launchBrowser } from '../app/lib/server/puppeteerCapture';
import type { TgImagePageData } from '../app/lib/discrepancyTgImageTypes';

function base64UrlEncode(json: string): string {
  return Buffer.from(json, 'utf-8').toString('base64url');
}

async function main() {
  const { token } = await createSessionToken({ id: 1, username: 'admin', role: 'admin', leaderId: null }, false);

  const pageData: TgImagePageData = {
    leader: 'CALIBRATION',
    line: 'cashout',
    pageNumber: 1,
    totalPages: 1,
    timestamp: '14 Oct 2026 · 3:16 PM GMT+6',
    headerTotal: 10999791,
    headerShopCount: 130,
    rows: Array.from({ length: 30 }, (_, i) => ({
      rowNumber: i + 1,
      shopName: `SHOP${String(i + 1).padStart(3, '0')}`,
      companyBalance: 658298,
      balanceInside: 777,
      agentWithdrawal: 657521,
    })),
  };

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
    await page.setCookie({ name: 'dashboard_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' });

    const encoded = base64UrlEncode(JSON.stringify(pageData));
    const url = new URL('http://localhost:3000/internal/discrepancy-tg-image');
    url.searchParams.set('data', encoded);
    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('[data-tg-image-ready="true"]', { timeout: 10000 });

    const measured = await page.evaluate(() => {
      const wrapper = document.querySelector('.tgimg') as HTMLElement;
      const card = document.querySelector('.card') as HTMLElement;
      return {
        wrapperHeightCss: wrapper.getBoundingClientRect().height,
        cardHeightCss: card.getBoundingClientRect().height,
        bodyScrollHeightCss: document.body.scrollHeight,
      };
    });
    console.log('30-row measurement (CSS px):', measured);
    console.log('At deviceScaleFactor 2 -> PNG px:', {
      wrapperHeightPng: measured.wrapperHeightCss * 2,
      bodyScrollHeightPng: measured.bodyScrollHeightCss * 2,
    });

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    console.log('Actual fullPage screenshot buffer size check — PNG dimensions via header bytes:');
    // PNG IHDR width/height are bytes 16-23 (big-endian uint32 each) — quick
    // read without pulling in an image-parsing dependency just for this.
    const buf = Buffer.from(screenshot);
    console.log({ pngWidth: buf.readUInt32BE(16), pngHeight: buf.readUInt32BE(20) });

    await page.close();
  } finally {
    await browser.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
