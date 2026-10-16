'use client';

// Server-render target for Unreconciled Balance's "Send to TG" feature —
// never opened by a real person. Puppeteer (see
// app/lib/server/unreconciledTgImageRenderer.ts) navigates here with the
// page's data base64-encoded in the `data` query param, waits for
// [data-tg-image-ready], then screenshots the whole page. Same convention
// as app/internal/discrepancy-tg-image/page.tsx.
import { useSearchParams } from 'next/navigation';
import type { UnreconciledTgImagePageData } from '@/app/lib/unreconciledTgImageTypes';
import { UNRECONCILED_TG_IMAGE_PAGE_HEIGHT_PX } from '@/app/lib/unreconciledTgImagePagination';
import { UnreconciledTgCard, UTGIMG_STYLES } from './UnreconciledTgCard';

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export default function UnreconciledTgImagePage() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('data');

  let data: UnreconciledTgImagePageData | null = null;
  try {
    data = raw ? (JSON.parse(base64UrlDecode(raw)) as UnreconciledTgImagePageData) : null;
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
      className="utgimg page"
      data-tg-image-ready="true"
      style={{ width: 1100, minHeight: UNRECONCILED_TG_IMAGE_PAGE_HEIGHT_PX, padding: 28 }}
    >
      <style>{UTGIMG_STYLES}</style>
      <UnreconciledTgCard data={data} />
    </div>
  );
}
