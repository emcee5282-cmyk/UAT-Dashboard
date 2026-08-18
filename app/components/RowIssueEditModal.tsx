'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Pencil, Check } from 'lucide-react';
import SearchableCombobox from './SearchableCombobox';
import AmountInput from './AmountInput';
import DateInput from './DateInput';
import type { RecordFormField } from './RecordFormModal';
import {
  MODAL_OVERLAY_CLASS,
  MODAL_CARD_CLASS,
  MODAL_GLYPH_CLASS,
  MODAL_GLYPH_STYLE,
  MODAL_GHOST_BUTTON_CLASS,
  MODAL_PRIMARY_BUTTON_SHAPE_CLASS,
  MODAL_ESC_HINT_CLASS,
  MODAL_ESC_KBD_CLASS,
} from './modalTheme';

// Purpose-built edit dialog for Bulk Import's per-row Edit action — a
// sibling to RecordFormModal (same field-schema shape, same low-level
// inputs/modal chrome), not a modification of it, since RecordFormModal's
// other callers (New/Edit Record elsewhere in the app) have no concept of
// "this field is highlighted because it's part of why this row was
// flagged." That's the one real behavioral difference: an amber ring on
// whichever fields make up the flagged issue (all six, for an exact-match
// duplicate; just the offending field, for a validation error), on top of
// RecordFormModal's own existing rose "this value is actually invalid"
// styling — the two are independent signals, not the same thing.
type RowIssueEditModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fields: RecordFormField[];
  initialValues: Record<string, string>;
  primaryButtonClassName: string;
  onSave: (values: Record<string, string>) => void;
  getFieldHint?: (key: string, value: string) => { message: string; details?: string[] } | null;
  dataProduct?: string;
  // Dynamic microcopy explaining why this row needs attention — empty
  // string renders no notice at all (a row with no remaining issues,
  // opened via a stale reference, shouldn't show a stale explanation).
  noticeText: string;
  noticeVariant: 'error' | 'duplicate';
  // 'all' for an exact-match duplicate (every field is part of the match),
  // a Set of specific field keys for a validation error.
  highlightedKeys: Set<string> | 'all';
};

export default function RowIssueEditModal({
  isOpen,
  onClose,
  title,
  fields,
  initialValues,
  primaryButtonClassName,
  onSave,
  getFieldHint,
  dataProduct,
  noticeText,
  noticeVariant,
  highlightedKeys,
}: RowIssueEditModalProps) {
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValues(initialValues);
      setTouched({});
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => setRendered(false), 120);
      return () => clearTimeout(timer);
    }
    // initialValues is a fresh object every render from the caller — only
    // isOpen's own transitions should drive this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!rendered || closing || fields.length === 0) return;
    const firstInvalid = getFieldHint
      ? fields.find((field) => getFieldHint(field.key, initialValues[field.key] ?? ''))
      : undefined;
    const targetKey = (firstInvalid ?? fields[0]).key;
    const firstControl = cardRef.current?.querySelector<HTMLElement>(`#issue-field-${targetKey}`);
    firstControl?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, closing]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // This modal is always opened ON TOP of BulkImportModal (which has
        // its own, separate document-level Escape-closes-the-wizard
        // listener). Both listeners live on `document`, not in a parent/
        // child DOM relationship, so a plain bubble-phase stopPropagation()
        // here wouldn't stop that sibling listener — it fires during the
        // SAME bubble phase, in registration order, and BulkImportModal's
        // registered first (it was already open when this modal mounted).
        // Registering this listener with `capture: true` instead makes it
        // run during the capture pass, before ANY bubble-phase listener on
        // document — including BulkImportModal's — gets a chance to run,
        // so stopPropagation() here reliably keeps Escape scoped to just
        // this modal. A second, separate Escape press then closes the
        // wizard behind it, same two-step convention SearchableCombobox's
        // own popup-vs-modal Escape handling already uses.
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const getFieldError = (field: RecordFormField): string | null => {
    const trimmed = (values[field.key] ?? '').trim();
    if (field.kind === 'date' && trimmed) {
      const parsed = new Date(trimmed);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (!isNaN(parsed.getTime()) && parsed.getTime() > today.getTime()) {
        return 'Future dates are not allowed.';
      }
    }
    if (!field.required) return null;
    if (!trimmed) return `${field.label} is required.`;
    if (field.kind === 'combobox' && !field.allowCustom && !field.options.some((option) => option.toLowerCase() === trimmed.toLowerCase())) {
      return `${field.label} is required.`;
    }
    return null;
  };
  const isFormValid = fields.every((field) => {
    if (getFieldHint?.(field.key, values[field.key] ?? '')) return false;
    return getFieldError(field) === null;
  });

  const markTouched = (key: string) => setTouched((current) => ({ ...current, [key]: true }));
  const isHighlighted = (key: string) => highlightedKeys === 'all' || highlightedKeys.has(key);

  const fieldRows: RecordFormField[][] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const next = fields[i + 1];
    if (field.kind === 'amount' && next?.kind === 'amount') {
      fieldRows.push([field, next]);
      i++;
    } else {
      fieldRows.push([field]);
    }
  }

  const handleSaveClick = () => {
    if (!isFormValid) {
      setTouched(Object.fromEntries(fields.map((field) => [field.key, true])));
      return;
    }
    onSave(values);
    onClose();
  };

  return createPortal(
    <div
      data-product={dataProduct}
      className={MODAL_OVERLAY_CLASS(closing)}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={MODAL_CARD_CLASS(closing)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
              <Pencil size={16} />
            </span>
            <div>
              <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {noticeText && (
          <div className={`mt-4 flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[11.5px] leading-snug ${
            noticeVariant === 'duplicate'
              ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-400'
          }`}>
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{noticeText}</span>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-4">
          {fieldRows.map((row, rowIndex) => {
            const isPairedAmountRow = row.length === 2;
            const rowContent = row.map((field) => {
              const fieldId = `issue-field-${field.key}`;
              const hint = getFieldHint?.(field.key, values[field.key] ?? '') ?? null;
              const errorMessage = hint ? hint.message : touched[field.key] ? getFieldError(field) : null;
              const error = errorMessage !== null;
              const highlighted = isHighlighted(field.key);
              return (
                <div
                  key={field.key}
                  className={highlighted ? 'rounded-[12px] bg-amber-50/60 p-2 ring-1 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/40' : ''}
                >
                  <label htmlFor={fieldId} className="mb-[7px] flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                    {field.label}
                    {field.required
                      ? <span className="text-rose-500">*</span>
                      : <span className="rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium tracking-wide text-muted-foreground">Optional</span>}
                  </label>

                  {field.kind === 'combobox' && (
                    <SearchableCombobox
                      id={fieldId}
                      value={values[field.key] ?? ''}
                      onChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
                      onBlur={() => markTouched(field.key)}
                      options={field.options}
                      allowCustom={field.allowCustom}
                      placeholder={field.placeholder}
                      error={error}
                    />
                  )}

                  {field.kind === 'amount' && (
                    <AmountInput
                      id={fieldId}
                      value={values[field.key] ?? ''}
                      onChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
                      onBlur={() => markTouched(field.key)}
                      placeholder={field.placeholder}
                      error={error}
                    />
                  )}

                  {field.kind === 'date' && (
                    <DateInput
                      id={fieldId}
                      value={values[field.key] ?? ''}
                      onChange={(next) => {
                        setValues((current) => ({ ...current, [field.key]: next }));
                        markTouched(field.key);
                      }}
                      onBlur={() => markTouched(field.key)}
                      error={error}
                    />
                  )}

                  {field.kind === 'text' && (
                    <input
                      id={fieldId}
                      type="text"
                      value={values[field.key] ?? ''}
                      onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                      onBlur={() => markTouched(field.key)}
                      placeholder={field.placeholder}
                      className={`h-10 w-full rounded-[10px] border bg-white px-3.5 text-[13px] text-foreground outline-none transition-colors focus:border-[color:var(--product-accent)] focus:ring-2 focus:ring-[color:var(--product-accent-soft)] dark:bg-[#1c1c1e] ${
                        error ? 'border-rose-400' : 'border-border'
                      }`}
                    />
                  )}

                  {errorMessage && (
                    <p className="mt-1 flex items-start gap-1 text-[11px] text-rose-600 dark:text-rose-400">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>{errorMessage}</span>
                    </p>
                  )}
                  {hint?.details && hint.details.length > 0 && (
                    <div className="mt-1 pl-4 text-[11px] text-muted-foreground">
                      <p>Available {field.label}s:</p>
                      {hint.details.map((option) => <p key={option}>• {option}</p>)}
                    </div>
                  )}
                </div>
              );
            });

            return (
              <div key={rowIndex}>
                {isPairedAmountRow && <hr className="mb-4 border-t border-border/60" />}
                {isPairedAmountRow
                  ? <div className="grid grid-cols-2 gap-3">{rowContent}</div>
                  : rowContent}
              </div>
            );
          })}
        </div>

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
              onClick={handleSaveClick}
              disabled={!isFormValid}
              className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${primaryButtonClassName}`}
            >
              <Check size={13} />
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
