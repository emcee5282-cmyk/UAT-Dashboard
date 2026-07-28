'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import SearchableCombobox from './SearchableCombobox';
import AmountInput from './AmountInput';
import DateInput from './DateInput';

// Discriminated by `kind` so RecordFormModal can render the right control
// per field without the caller needing to know anything about
// SearchableCombobox/AmountInput/DateInput directly — a module (Settlement
// today; Users/Agents/Wallets later per spec) just describes its fields
// declaratively. `text` is a plain fallback for anything that doesn't need
// a specialized control yet.
export type RecordFormField =
  | { key: string; label: string; kind: 'combobox'; options: string[]; allowCustom?: boolean; required?: boolean; placeholder?: string }
  | { key: string; label: string; kind: 'amount'; required?: boolean; placeholder?: string }
  | { key: string; label: string; kind: 'date'; required?: boolean }
  | { key: string; label: string; kind: 'text'; required?: boolean; placeholder?: string };

// Prototype/UI-only, per explicit spec: Save never persists anywhere — it
// only closes the modal (still gated on valid required fields, but nothing
// downstream of that gate touches real data yet). Same shape and behavior
// serves both "New Record" (empty initialValues) and "Edit Record"
// (prefilled initialValues) — both Cashout and Send Money Settlement wire
// up both today.
type RecordFormModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fields: RecordFormField[];
  initialValues: Record<string, string>;
  primaryButtonClassName: string;
  // Optional — callers that only need the UI-only prototype behavior (New/
  // Edit Record on the Settlement pages today) omit this and Save just
  // closes, per spec. A caller that actually needs the edited values back
  // (Bulk Import's per-row "fix it here" edit) passes this to receive them
  // before the modal closes.
  onSave?: (values: Record<string, string>) => void;
  // Optional — a caller with its own business-rule engine (Bulk Import's
  // "Agent not found in Balance Shop" / "Wallet not supported" / etc.)
  // supplies this to show the REAL reason a field is invalid, immediately
  // on open rather than waiting for blur, instead of this modal's own
  // generic required/closed-set message. Re-evaluated on every render
  // against the field's current value, so fixing it clears the warning
  // instantly — no separate "revalidate" step needed.
  getFieldHint?: (key: string, value: string) => { message: string; details?: string[] } | null;
  // Send Money's primaryButtonClassName resolves var(--product-accent),
  // scoped to [data-product="sendmoney"] on AppShell's own wrapper —
  // createPortal renders this modal straight onto document.body, outside
  // that wrapper, so the variable silently fails to resolve and the button
  // paints invisible unless this is set to re-establish scope on the
  // portal root itself. Same fix UploadExcelModal already uses.
  dataProduct?: string;
};

export default function RecordFormModal({
  isOpen,
  onClose,
  title,
  fields,
  initialValues,
  primaryButtonClassName,
  onSave,
  getFieldHint,
  dataProduct,
}: RecordFormModalProps) {
  // Own local, disposable copy of the field values — typing here never
  // touches the caller's real row/table data, and it's discarded (not
  // persisted) on every close, per the "no local state mutation" spec.
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  // Gates when a required-field error is actually shown — a field only
  // reports "required" after the user has interacted with (blurred) it, or
  // after a Save attempt, never on first render of an empty New Record form.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Lags `isOpen` by the exit-animation duration so the closing card/overlay
  // fade+scale actually gets to play instead of the component unmounting
  // mid-transition — same pattern as this app's own dt-fade-in/dt-fade-out.
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
    // Focus the first field that actually has a business-rule problem
    // (per getFieldHint) rather than always fields[0], so an Edit opened
    // from a validation error jumps straight to what needs fixing. Reads
    // initialValues (a prop, always current) rather than the `values`
    // state, which may not have flushed from the sibling effect above yet
    // on this same open.
    const firstInvalid = getFieldHint
      ? fields.find((field) => getFieldHint(field.key, initialValues[field.key] ?? ''))
      : undefined;
    const targetKey = (firstInvalid ?? fields[0]).key;
    const firstControl = cardRef.current?.querySelector<HTMLElement>(`#record-field-${targetKey}`);
    firstControl?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, closing]);

  // ESC to close + a minimal Tab focus trap, scoped to the card only while
  // it's actually open (not during its own closing animation). A combobox/
  // date popup's own Escape stops this from firing via stopPropagation
  // while its popup is open, so the first Escape only closes the popup.
  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  // Returns the specific message to show, or null if the field is valid —
  // a date field's own "future date" check applies regardless of
  // required-ness (an optional field that DOES have a value still can't
  // hold an invalid one), everything else only matters when required.
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
    // A closed-set combobox (allowCustom false) requires the value to
    // actually be one of its options, not merely non-empty — otherwise a
    // pre-existing/legacy value that never matches any real option (e.g.
    // an unresolved "−" brand from source data) would silently pass
    // validation despite "no custom values" being the whole point.
    //
    // Case-INSENSITIVE match — same convention as the business-rule
    // checkers this modal's own getFieldHint calls (checkAgentNameField/
    // checkWalletField/etc. in settlementValidation.ts all lowercase both
    // sides). A raw roster/option list is typically ALL CAPS from the
    // sheet, while this modal's own initialValues are proper-cased for
    // display (toProperCase) — an exact case-sensitive `.includes()` here
    // meant Agent Name (and any other proper-cased closed-set field) could
    // NEVER pass this check, permanently blocking Save on a field that was
    // never actually the reported problem, even after the real error
    // (e.g. Wallet) was fixed. Confirmed via Bulk Import's per-row Edit
    // dialog: fixing Wallet alone still left Save disabled because Agent
    // Name silently failed this exact-match check every time.
    if (field.kind === 'combobox' && !field.allowCustom && !field.options.some((option) => option.toLowerCase() === trimmed.toLowerCase())) {
      return `${field.label} is required.`;
    }
    return null;
  };
  // A business-rule hint (when supplied) always wins over the generic
  // check — it's the actual reason the field is invalid, not a fallback.
  const isFormValid = fields.every((field) => {
    if (getFieldHint?.(field.key, values[field.key] ?? '')) return false;
    return getFieldError(field) === null;
  });

  const markTouched = (key: string) => setTouched((current) => ({ ...current, [key]: true }));

  const handleSaveClick = () => {
    if (!isFormValid) {
      setTouched(Object.fromEntries(fields.map((field) => [field.key, true])));
      return;
    }
    onSave?.(values);
    onClose();
  };

  return createPortal(
    <div
      data-product={dataProduct}
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4 ${closing ? 'dt-modal-overlay-out' : 'dt-modal-overlay-in'}`}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-2xl rounded-xl border border-border bg-white p-6 shadow-xl dark:bg-[#2a2a2d] ${closing ? 'dt-modal-card-out' : 'dt-modal-card-in'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 space-y-5">
          {fields.map((field) => {
            const fieldId = `record-field-${field.key}`;
            // A business-rule hint shows immediately (not gated behind
            // touched) — that's the whole point of "guide the user to
            // every validation issue the instant the dialog opens."
            const hint = getFieldHint?.(field.key, values[field.key] ?? '') ?? null;
            const errorMessage = hint ? hint.message : touched[field.key] ? getFieldError(field) : null;
            const error = errorMessage !== null;
            return (
              <div key={field.key}>
                <label htmlFor={fieldId} className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                  {field.label}
                  {field.required && <span className="ml-0.5 text-rose-500">*</span>}
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
                    className={`h-10 w-full rounded-lg border bg-white px-3 text-[13px] text-foreground outline-none transition-colors focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 dark:bg-[#1c1c1e] ${
                      error ? 'border-rose-400' : 'border-border'
                    }`}
                  />
                )}

                {/* A business-rule hint (see getFieldHint above) shows
                    immediately; the generic required/closed-set check only
                    appears once the field has been touched (blurred) or a
                    Save attempt was made — never on first render of an
                    empty form. No browser-native validation popups here. */}
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
          })}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            disabled={!isFormValid}
            className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${primaryButtonClassName}`}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
