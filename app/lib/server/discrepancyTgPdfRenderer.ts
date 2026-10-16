// Renders one leader+line's full page set to a single multi-page PDF by
// navigating a shared Puppeteer browser to app/internal/discrepancy-tg-pdf
// (same screenshot-the-real-Next.js-page approach as
// discrepancyTgImageRenderer.ts). Vector output built from the live
// HTML/CSS template, not a PNG screenshot embedded in a PDF — text stays
// selectable and sharp at any zoom, per explicit instruction.
//
// All pages except the last are rendered TOGETHER as one fixed-height
// multi-page PDF (reliable: Puppeteer's page.pdf({width,height}) applies
// ONE page size to the whole document, and every one of these pages is a
// full 30-row page anyway, so "fixed" and "natural" are the same number
// for them). The LAST page is rendered SEPARATELY at its own measured
// natural content height (could be a short <30-row page, or the only page
// of a single-page PDF) — per explicit correction, a short last page no
// longer keeps the fixed height with empty space below its last row.
// `@page { size: W auto }` was tried first for this and found unreliable:
// confirmed live, even a single un-paginated section still got sliced at a
// fixed default height by Chromium's print engine, never actually sized to
// its real content. Measuring the content height via page.evaluate() and
// passing that EXACT px value into page.pdf()'s own width/height options
// is the only approach that reliably worked — the same lesson
// TG_IMAGE_PAGE_HEIGHT_PX's own calibration script already learned. The
// two PDFs (if there was more than one page total) are merged into one
// file with pdf-lib.
import type { Browser } from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import { SESSION_COOKIE_NAME } from '../auth/session';
import type { TgImagePageData } from '../discrepancyTgImageTypes';
import { TG_PDF_PAGE_HEIGHT_PX, TG_PAGE_PADDING_PX } from '../discrepancyTgImagePagination';
import { stashPdfPageData, clearPdfPageData } from './discrepancyTgPdfDataStore';

async function setUpPage(browser: Browser, origin: string, sessionToken: string | undefined, viewportHeight: number) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: viewportHeight, deviceScaleFactor: 2 });
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
  return page;
}

// One or more FULL (30-row) pages, all the same height — the original,
// reliable fixed-height multi-page render.
async function renderFixedPages(browser: Browser, origin: string, sessionToken: string | undefined, pages: TgImagePageData[]): Promise<Buffer> {
  const page = await setUpPage(browser, origin, sessionToken, 1600);
  const id = stashPdfPageData(pages);
  try {
    // A real job can run to 80+ pages (confirmed live) — far too large for
    // a URL query string, so only a short lookup id travels through the
    // URL; the actual page array is fetched by the render page itself from
    // discrepancyTgPdfDataStore via /api/internal's own GET route.
    const url = new URL('/internal/discrepancy-tg-pdf', origin);
    url.searchParams.set('id', id);

    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 60000 });
    // A real job can run to 80+ pages (confirmed live: JAVED's Send Money
    // line took ~30s end to end at 89 pages) — generous headroom over that.
    await page.waitForSelector('[data-tg-image-ready="true"]', { timeout: 90000 });

    // page.pdf() has its OWN default 30s timeout, entirely separate from
    // the waitForSelector call above — confirmed live: JAVED's 89-page
    // Send Money PDF failed with "Timed out after waiting 30000ms" even
    // after the waitForSelector timeout had already been raised, because
    // that bump never touched this call's own internal ceiling.
    const pdf = await page.pdf({
      width: '1100px',
      height: `${TG_PDF_PAGE_HEIGHT_PX}px`,
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      timeout: 120000,
    });
    return Buffer.from(pdf);
  } finally {
    clearPdfPageData(id);
    await page.close();
  }
}

// Exactly one page, sized to its own natural content height (never padded
// to a fixed page size) — used for the last page of a job, whatever its
// row count turns out to be.
async function renderNaturalPage(browser: Browser, origin: string, sessionToken: string | undefined, pageData: TgImagePageData): Promise<Buffer> {
  const page = await setUpPage(browser, origin, sessionToken, 1600);
  const id = stashPdfPageData([pageData]);
  try {
    const url = new URL('/internal/discrepancy-tg-pdf', origin);
    url.searchParams.set('id', id);
    url.searchParams.set('natural', '1');

    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('[data-tg-image-ready="true"]', { timeout: 30000 });

    const measuredHeight = await page.evaluate((paddingPx: number) => {
      const card = document.querySelector('.card') as HTMLElement | null;
      // The page's own top+bottom padding around the card (same convention
      // the fixed-height render's own page.tsx uses) isn't part of the
      // card's own measured height, so it's added back here.
      return (card?.getBoundingClientRect().height ?? 0) + paddingPx * 2;
    }, TG_PAGE_PADDING_PX);

    const pdf = await page.pdf({
      width: '1100px',
      height: `${Math.ceil(measuredHeight)}px`,
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      timeout: 60000,
    });
    return Buffer.from(pdf);
  } finally {
    clearPdfPageData(id);
    await page.close();
  }
}

export async function renderDiscrepancyPdf(browser: Browser, origin: string, sessionToken: string | undefined, pages: TgImagePageData[]): Promise<Buffer> {
  const fullPages = pages.slice(0, -1);
  const lastPage = pages[pages.length - 1];

  const lastPageBuffer = await renderNaturalPage(browser, origin, sessionToken, lastPage);
  if (fullPages.length === 0) return lastPageBuffer;

  const fullPagesBuffer = await renderFixedPages(browser, origin, sessionToken, fullPages);

  const merged = await PDFDocument.create();
  for (const buf of [fullPagesBuffer, lastPageBuffer]) {
    const doc = await PDFDocument.load(buf);
    const copiedPages = await merged.copyPages(doc, doc.getPageIndices());
    copiedPages.forEach((p) => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}
