import type { CSSProperties } from 'react';

// Shared "premium" chrome for every small centered form-style dialog
// (RecordFormModal, BulkEditModal, ConfirmDeleteModal) — per explicit
// instruction to apply one consistent modal look across all of them,
// adapted to the app's own tokens/dark-mode instead of the fixed purple
// the original design reference used: the glyph/border/focus-ring color is
// var(--product-accent), so Cashout renders indigo and Send Money renders
// teal automatically, and it respects the site's real dark/light toggle
// (no separate theme switch inside the modal). Structural/animation-only
// modals (BulkImportModal's wide table-based uploader, WalletSettingsModal)
// are intentionally NOT included — this card shell assumes a small,
// single-column form and would misfit a wide table layout.
export const MODAL_OVERLAY_CLASS = (closing: boolean) =>
  `fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[2px] ${
    closing ? 'dt-modal-overlay-out' : 'dt-modal-overlay-in'
  }`;

// The accent-colored 1px ring (mimicking the reference design's gradient
// border without a second wrapper element) is layered as a second
// box-shadow alongside the theme-aware drop shadow, in one arbitrary-value
// class — an inline style would collide with (fully override, not layer
// with) this same property instead of combining.
// 440px / 28px-28px-24px padding — taken directly from the reference
// design's own .modal rule, not eyeballed. Same width for every one of
// these small dialogs (New/Edit Account, Bulk Edit, Delete confirm), per
// explicit instruction to keep the whole modal set consistent.
export const MODAL_CARD_CLASS = (closing: boolean, maxWidth: string = 'max-w-[440px]') =>
  `relative w-full ${maxWidth} rounded-[20px] border border-border bg-white px-7 pt-7 pb-6 shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.35)] dark:bg-[#16161d] dark:shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.7)] ${
    closing ? 'dt-modal-card-out' : 'dt-modal-card-in'
  }`;

// 34x34, radius 9 — also taken directly from the reference .glyph rule.
export const MODAL_GLYPH_CLASS =
  'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] text-white shadow-[0_4px_14px_-2px_var(--product-accent)]';
export const MODAL_GLYPH_STYLE: CSSProperties = {
  background: 'linear-gradient(155deg, var(--product-accent), color-mix(in srgb, var(--product-accent) 100%, black 18%))',
};

export const MODAL_INPUT_FOCUS_CLASS =
  'focus:border-[color:var(--product-accent)] focus:ring-2 focus:ring-[color:var(--product-accent-soft)]';

export const MODAL_GHOST_BUTTON_CLASS =
  'rounded-[10px] border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted';

export const MODAL_PRIMARY_BUTTON_SHAPE_CLASS =
  'inline-flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[12px] font-semibold text-white shadow-[0_6px_16px_-4px_var(--product-accent)] transition-[transform,box-shadow] duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0';

// Same shape, rose-tinted shadow — for Delete's primaryButtonClassName
// (always bg-rose-600), so the glow doesn't clash with the product accent.
export const MODAL_DESTRUCTIVE_BUTTON_SHAPE_CLASS =
  'inline-flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[12px] font-semibold text-white shadow-[0_6px_16px_-4px_rgba(225,29,72,0.55)] transition-[transform,box-shadow] duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0';

export const MODAL_ESC_HINT_CLASS =
  'hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex';
export const MODAL_ESC_KBD_CLASS =
  'rounded-[5px] border border-border bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold text-foreground';

// Wide-card variant for BulkImportModal — same rounded-20/glow-border chrome
// as MODAL_CARD_CLASS, but sized to the reference design's own container
// exactly: max-w-[560px], no fixed height (content-driven like the
// reference's plain .modal, capped at max-h-[85vh] with internal scroll as
// a viewport safety net, not a forced minimum height).
export const MODAL_WIDE_CARD_CLASS = (closing: boolean) =>
  `relative flex max-h-[85vh] w-full max-w-[560px] flex-col rounded-[20px] border border-border bg-white shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.35)] dark:bg-[#16161d] dark:shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.7)] ${
    closing ? 'dt-modal-card-out' : 'dt-modal-card-in'
  }`;

// Bordered-square close button (reference's .close-btn) — used on
// BulkImportModal, which per its own reference mockup uses this style
// instead of the plain hover-icon close the smaller form dialogs use.
export const MODAL_CLOSE_BUTTON_CLASS =
  'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-border bg-muted/40 text-muted-foreground transition-colors hover:border-[color:var(--product-accent)] hover:text-foreground';
