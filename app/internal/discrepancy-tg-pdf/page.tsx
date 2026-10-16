'use client';

// Server-render target for the Discrepancy TG "Send to TG" feature's PDF
// path — never opened by a real person. Puppeteer
// (app/lib/server/discrepancyTgPdfRenderer.ts) navigates here with a short
// `id` query param; the actual page data (which can run to 80+ pages for a
// real leader+line — far too large for a URL query string, confirmed live)
// is fetched from discrepancyTgPdfDataStore via /api/internal's own tiny
// GET route instead. [data-tg-image-ready] is only set once that fetch
// resolves (or fails), same "wait for this, then screenshot/pdf() it"
// contract the single-photo template uses.
//
// Two render modes, chosen by the caller (discrepancyTgPdfRenderer.ts):
// - Default (`natural` absent): every `.pdfpage` is pinned to
//   TG_PDF_PAGE_HEIGHT_PX (the card's own calibrated height PLUS this
//   wrapper's own 28px top+bottom padding — using just the card's height
//   here was a real bug, caught live: with box-sizing:border-box, the
//   padding ate into the box the card needed, overflowing it by exactly
//   that padding amount, and overflow:hidden silently clipped the footer
//   off the bottom of every full page) — reliable for N UNIFORM 30-row
//   pages, since Puppeteer's page.pdf({width,height}) applies one page
//   size to the WHOLE document. Used for every full page.
// - `?natural=1`: renders the single page's card at its own natural
//   content height (`fillHeight={false}`, no pinned height) — used ONLY
//   for the last page, which the caller measures via page.evaluate() and
//   then passes that EXACT px value into ITS OWN separate page.pdf() call.
//   (`@page { size: W auto }` was tried first and found unreliable —
//   confirmed live: even a single, un-paginated section still got sliced
//   at a fixed default height by Chromium's print engine, not sized to
//   its actual content. Explicit, measured heights are the only path that
//   actually works, same lesson TG_IMAGE_PAGE_HEIGHT_PX's own calibration
//   script already learned.) The caller then merges the two separately
//   rendered PDFs (full pages + the one natural-height page) into one
//   file — see renderDiscrepancyPdf's own comment.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { TgImagePageData } from '@/app/lib/discrepancyTgImageTypes';
import { TG_PDF_PAGE_HEIGHT_PX } from '@/app/lib/discrepancyTgImagePagination';
import { DiscrepancyTgCard, TGIMG_STYLES } from '../discrepancy-tg-image/DiscrepancyTgCard';

export default function DiscrepancyTgPdfPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const natural = searchParams.get('natural') === '1';
  const [pages, setPages] = useState<TgImagePageData[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    fetch(`/api/internal/discrepancy-tg-pdf-data?id=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { pages: TgImagePageData[] }) => {
        if (!cancelled) setPages(data.pages);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (failed || (pages && pages.length === 0)) {
    return (
      <div data-tg-image-ready="true" style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
        Invalid or missing PDF page data.
      </div>
    );
  }

  if (!pages) {
    // No data-tg-image-ready yet — Puppeteer's waitForSelector keeps
    // waiting through this fetch, same as it would through any other
    // loading state.
    return <div style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>Loading…</div>;
  }

  return (
    <div className="tgimg" data-tg-image-ready="true">
      <style>{`
        ${TGIMG_STYLES}
        ${natural ? '' : `@page { size: 1100px ${TG_PDF_PAGE_HEIGHT_PX}px; margin: 0; }`}
        html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .tgimg .pdfpage {
          width: 1100px;
          ${natural ? '' : `height: ${TG_PDF_PAGE_HEIGHT_PX}px;`}
          padding: 28px;
          background: #eef1f7;
          break-after: page;
          box-sizing: border-box;
          ${natural ? '' : 'overflow: hidden;'}
        }
        .tgimg .pdfpage:last-child { break-after: auto; }
      `}</style>
      {pages.map((data) => (
        <div className="pdfpage" key={data.pageNumber}>
          <DiscrepancyTgCard data={data} fillHeight={!natural} />
        </div>
      ))}
    </div>
  );
}
