// In-process handoff for the PDF render target's page data — a real
// leader+line job (up to 89+ pages seen live, e.g. JAVED's Send Money line)
// is far too large to round-trip through a URL query string the way the
// single-photo template does for one page at a time (confirmed live: a
// 90-row/3-page payload already failed to navigate — the query string blew
// past what the browser/server would carry). Puppeteer and the API route
// that serves this both run inside the SAME single request's Node process
// (runDiscrepancyTgSend executes synchronously end to end, VPS or Vercel),
// so a plain in-memory Map is enough — no Redis/DB table needed for what's
// effectively a same-process handoff with a few seconds' lifetime.
import type { TgImagePageData } from '../discrepancyTgImageTypes';
import { randomUUID } from 'crypto';

const STORE = new Map<string, { pages: TgImagePageData[]; expiresAt: number }>();
const TTL_MS = 2 * 60 * 1000; // generous ceiling for a slow render; swept below regardless

function sweep() {
  const now = Date.now();
  for (const [id, entry] of STORE) {
    if (entry.expiresAt < now) STORE.delete(id);
  }
}

export function stashPdfPageData(pages: TgImagePageData[]): string {
  sweep();
  const id = randomUUID();
  STORE.set(id, { pages, expiresAt: Date.now() + TTL_MS });
  return id;
}

// Non-destructive on purpose — NOT delete-on-read. The render page's own
// effect fires this fetch twice in dev (React Strict Mode double-invokes
// effects on mount); a delete-on-read "take" meant the second call 404'd
// and flipped the page to its error state right after Puppeteer had
// already seen [data-tg-image-ready] and started page.pdf() — confirmed
// live: the captured PDF showed "Invalid or missing PDF page data." despite
// the render having reported success. The TTL sweep (plus the explicit
// clearPdfPageData below, once the renderer is actually done with it) is
// what actually reclaims memory instead.
export function getPdfPageData(id: string): TgImagePageData[] | null {
  const entry = STORE.get(id);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.pages;
}

export function clearPdfPageData(id: string): void {
  STORE.delete(id);
}
