'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { MODAL_GHOST_BUTTON_CLASS, MODAL_PRIMARY_BUTTON_SHAPE_CLASS } from './modalTheme';
import type { CropRect } from '@/app/lib/avatarImage';

// Profile modal's crop step (Telegram-style): a square viewport with a
// circular mask; drag to pan, slider or mouse wheel to zoom. The image
// always covers the viewport (zoom 1 = shorter side fills it), so the crop
// never includes empty space. Apply hands back the square region in the
// source's natural pixels — the export itself is exportAvatarCrop.
const VIEWPORT = 280;
const MAX_ZOOM = 4;
const PAN_STEP = 10;

type View = { zoom: number; x: number; y: number }; // x/y: image center offset from viewport center, CSS px

export default function AvatarCropper({
  img,
  src,
  onCancel,
  onApply,
}: {
  img: HTMLImageElement;
  src: string;
  onCancel: () => void;
  onApply: (crop: CropRect) => void;
}) {
  const base = VIEWPORT / Math.min(img.naturalWidth, img.naturalHeight);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number } | null>(null);

  const clamp = useCallback(
    (v: View): View => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom));
      const s = base * zoom;
      const maxX = (img.naturalWidth * s - VIEWPORT) / 2;
      const maxY = (img.naturalHeight * s - VIEWPORT) / 2;
      return { zoom, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
    },
    [base, img]
  );

  // Zoom about a point (viewport-center-relative px) so it stays put.
  const zoomTo = useCallback(
    (nextZoom: number, px = 0, py = 0) =>
      setView((v) => {
        const z = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
        const r = z / v.zoom;
        return clamp({ zoom: z, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
      }),
    [clamp]
  );

  // Wheel needs a non-passive listener to stop the page/modal scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left - VIEWPORT / 2;
      const py = event.clientY - rect.top - VIEWPORT / 2;
      setView((v) => {
        const z = Math.min(MAX_ZOOM, Math.max(1, v.zoom * Math.exp(-event.deltaY * 0.0015)));
        const r = z / v.zoom;
        return clamp({ zoom: z, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clamp]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, px: event.clientX, py: event.clientY, x: view.x, y: view.y };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    setView((v) => clamp({ ...v, x: d.x + event.clientX - d.px, y: d.y + event.clientY - d.py }));
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setView((v) => clamp({ ...v, x: v.x + move[0], y: v.y + move[1] }));
    } else if (event.key === '+' || event.key === '=') {
      zoomTo(view.zoom * 1.1);
    } else if (event.key === '-') {
      zoomTo(view.zoom / 1.1);
    }
  };

  const apply = () => {
    const s = base * view.zoom;
    const size = Math.min(VIEWPORT / s, img.naturalWidth, img.naturalHeight);
    const left = VIEWPORT / 2 + view.x - (img.naturalWidth * s) / 2;
    const top = VIEWPORT / 2 + view.y - (img.naturalHeight * s) / 2;
    const x = Math.min(img.naturalWidth - size, Math.max(0, -left / s));
    const y = Math.min(img.naturalHeight - size, Math.max(0, -top / s));
    onApply({ x, y, size });
  };

  const s = base * view.zoom;
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;

  return (
    <>
      <div className="flex flex-col items-center px-6 py-6">
        <div
          ref={viewportRef}
          role="application"
          aria-label="Crop photo. Drag or use arrow keys to move, scroll or plus and minus to zoom."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="relative cursor-grab touch-none select-none overflow-hidden rounded-[12px] bg-black outline-none focus-visible:ring-2 focus-visible:ring-[#4F46E5] active:cursor-grabbing"
          style={{ width: VIEWPORT, height: VIEWPORT }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL being cropped */}
          <img
            src={src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute left-0 top-0 max-w-none"
            style={{
              width: w,
              height: h,
              transform: `translate(${VIEWPORT / 2 + view.x - w / 2}px, ${VIEWPORT / 2 + view.y - h / 2}px)`,
            }}
          />
          {/* Circular mask: everything outside the circle is dimmed. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/70"
            style={{ boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)' }}
          />
        </div>

        <div className="mt-5 flex w-full max-w-[280px] items-center gap-3 text-muted-foreground">
          <button type="button" onClick={() => zoomTo(view.zoom / 1.25)} aria-label="Zoom out" className="shrink-0 transition-colors hover:text-foreground">
            <ZoomOut size={15} />
          </button>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            onChange={(event) => zoomTo(Number(event.target.value))}
            aria-label="Zoom"
            className="h-1 flex-1 cursor-pointer accent-[#4F46E5]"
          />
          <button type="button" onClick={() => zoomTo(view.zoom * 1.25)} aria-label="Zoom in" className="shrink-0 transition-colors hover:text-foreground">
            <ZoomIn size={15} />
          </button>
        </div>
        <p className="mt-2.5 text-center text-[11px] text-muted-foreground">Drag to reposition · scroll or use the slider to zoom</p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4 dark:bg-white/[0.02]">
        <button type="button" onClick={onCancel} className={MODAL_GHOST_BUTTON_CLASS}>
          Cancel
        </button>
        <button type="button" onClick={apply} className={MODAL_PRIMARY_BUTTON_SHAPE_CLASS} style={{ background: '#4F46E5' }}>
          Apply
        </button>
      </div>
    </>
  );
}
