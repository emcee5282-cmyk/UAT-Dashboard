'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { MODAL_OVERLAY_CLASS, MODAL_CARD_CLASS, MODAL_GHOST_BUTTON_CLASS, MODAL_DESTRUCTIVE_BUTTON_SHAPE_CLASS, MODAL_ESC_HINT_CLASS, MODAL_ESC_KBD_CLASS } from './modalTheme';

// Phase 7 — the required SECOND confirmation step before any Delete action
// actually mutates PostgreSQL. Same overlay/card/animation shell as
// RecordFormModal/BulkEditModal (modalTheme.ts) so it reads as the same
// design system — the round rose glyph stays destructive-red rather than
// the shared product-accent square glyph those two use, per the app's own
// "semantic color pair" rule for anything destructive. Same async
// onConfirm + inline-error pattern as those two modals: a rejected
// onConfirm keeps the dialog open and shows why, never silently closes as
// if the delete had succeeded.
type ConfirmDeleteModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  subject: string;
  primaryButtonClassName: string;
  dataProduct?: string;
};

export default function ConfirmDeleteModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  subject,
  primaryButtonClassName,
  dataProduct,
}: ConfirmDeleteModalProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setDeleting(false);
      setError(null);
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => setRendered(false), 120);
      return () => clearTimeout(timer);
    }
  }, [isOpen, rendered]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const handleConfirmClick = async () => {
    try {
      setDeleting(true);
      setError(null);
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  return createPortal(
    <div
      data-product={dataProduct}
      className={MODAL_OVERLAY_CLASS(closing)}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={MODAL_CARD_CLASS(closing)}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
            <AlertTriangle size={17} />
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              You are about to delete <span className="font-semibold text-foreground">{subject}</span>. This action cannot be undone.
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
          <span className={MODAL_ESC_HINT_CLASS}>
            <kbd className={MODAL_ESC_KBD_CLASS}>Esc</kbd> to cancel
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={MODAL_GHOST_BUTTON_CLASS}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmClick}
              disabled={deleting}
              className={`${MODAL_DESTRUCTIVE_BUTTON_SHAPE_CLASS} ${primaryButtonClassName}`}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
