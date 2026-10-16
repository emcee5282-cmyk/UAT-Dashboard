'use client';

// Server-render target for the Discrepancy TG "Send to TG" feature — never
// opened by a real person. Puppeteer (see
// app/lib/server/discrepancyTgImageRenderer.ts) navigates here with the
// page's data base64-encoded in the `data` query param, waits for
// [data-tg-image-ready], then screenshots the whole page. Card markup/CSS
// lives in ./DiscrepancyTgCard.tsx, shared with ../discrepancy-tg-pdf's
// multi-page target so neither can drift from the other.
import { useSearchParams } from 'next/navigation';
import type { TgImagePageData } from '@/app/lib/discrepancyTgImageTypes';
import { TG_IMAGE_PAGE_HEIGHT_PX } from '@/app/lib/discrepancyTgImagePagination';
import { DiscrepancyTgCard, TGIMG_STYLES } from './DiscrepancyTgCard';

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export default function DiscrepancyTgImagePage() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('data');

  let data: TgImagePageData | null = null;
  try {
    data = raw ? (JSON.parse(base64UrlDecode(raw)) as TgImagePageData) : null;
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <div data-tg-image-ready="true" style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
        Invalid or missing image data.
      </div>
    );
  }

  return (
    <div
      className="tgimg"
      data-tg-image-ready="true"
      style={{ width: 1100, minHeight: TG_IMAGE_PAGE_HEIGHT_PX, padding: 28, background: '#eef1f7' }}
    >
      <style>{TGIMG_STYLES}</style>
      <DiscrepancyTgCard data={data} />
    </div>
  );
}
