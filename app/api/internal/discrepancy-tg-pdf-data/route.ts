import { NextRequest, NextResponse } from 'next/server';
import { getPdfPageData } from '@/app/lib/server/discrepancyTgPdfDataStore';

// Fetched client-side by app/internal/discrepancy-tg-pdf/page.tsx (running
// inside Puppeteer's own browser context, which carries the same session
// cookie the renderer set) — the `id` query param is the only thing that
// ever travels through a URL; the actual page data stays server-side, same
// process. Non-destructive read (see discrepancyTgPdfDataStore's own
// comment — this gets fetched twice in dev under Strict Mode, so deleting
// on first read broke the second call). Session auth alone (via
// middleware's default gate) is enough here, same as every other /internal
// destination — this isn't admin-only on its own merits, it just can't be
// reached without already being inside an authenticated send run.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const pages = getPdfPageData(id);
  if (!pages) return NextResponse.json({ error: 'Not found or expired' }, { status: 404 });

  return NextResponse.json({ pages }, { headers: { 'Cache-Control': 'no-store' } });
}
