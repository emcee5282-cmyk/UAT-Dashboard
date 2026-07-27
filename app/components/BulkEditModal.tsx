'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import SearchableCombobox from './SearchableCombobox';
import DateInput from './DateInput';

// Applies ONE new value to a chosen field across every selected row at
// once — deliberately narrow (Wallet/Remarks/Date only, per explicit
// spec): Brand/Agent Name/Amount stay out since those are effectively
// unique per record and mass-overwriting them is far more likely to be a
// mistake than an intended bulk action. Each field is independently
// toggled ("Update Wallet") so the user can change just one, two, or all
// three in a single pass — untouched fields keep each row's own value.
// UI-only prototype, same convention as RecordFormModal/BulkImportModal:
// onApply hands the caller plain field values, nothing here persists
// anywhere or knows about a database.
export type BulkEditUpdates = {
  wallet?: string;
  remarks?: string;
  // DateInput's own display format ("Jul 24, 2026") — the caller converts
  // this to its own row storage format (each Settlement page already has
  // its own raw "M/D/YYYY" convention and its own small parser for it).
  date?: string;
};

type BulkEditModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (updates: BulkEditUpdates) => void;
  selectedCount: number;
  walletOptions: string[];
  remarksSuggestions: string[];
  primaryButtonClassName: string;
  // Same fix as BulkImportModal/RecordFormModal — Send Money's
  // primaryButtonClassName resolves var(--product-accent), scoped to
  // [data-product="sendmoney"]; createPortal renders outside that scope,
  // so this re-establishes it on the portal root.
  dataProduct?: string;
};

export default function BulkEditModal({
  isOpen,
  onClose,
  onApply,
  selectedCount,
  walletOptions,
  remarksSuggestions,
  primaryButtonClassName,
  dataProduct,
}: BulkEditModalProps) {
  const [walletEnabled, setWalletEnabled] = useState(false);
  const [remarksEnabled, setRemarksEnabled] = useState(false);
  const [dateEnabled, setDateEnabled] = useState(false);
  const [wallet, setWallet] = useState('');
  const [remarks, setRemarks] = useState('');
  const [date, setDate] = useState('');
  // Same open/close animation-lag pattern as RecordFormModal/
  // BulkImportModal — the closing fade/scale gets to actually play.
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setWalletEnabled(false);
      setRemarksEnabled(false);
      setDateEnabled(false);
      setWallet('');
      setRemarks('');
      setDate('');
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => setRendered(false), 120);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const hasAnyFieldEnabled = walletEnabled || remarksEnabled || dateEnabled;
  const canApply = hasAnyFieldEnabled
    && (!walletEnabled || wallet.trim() !== '')
    && (!remarksEnabled || remarks.trim() !== '')
    && (!dateEnabled || date.trim() !== '');

  const handleApplyClick = () => {
    if (!canApply) return;
    onApply({
      ...(walletEnabled ? { wallet } : {}),
      ...(remarksEnabled ? { remarks } : {}),
      ...(dateEnabled ? { date } : {}),
    });
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
        aria-label="Bulk Edit Settlement Records"
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-md rounded-xl border border-border bg-white p-6 shadow-xl dark:bg-[#2a2a2d] ${closing ? 'dt-modal-card-out' : 'dt-modal-card-in'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-bold text-foreground">Bulk Edit</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Applying to {selectedCount} selected record{selectedCount === 1 ? '' : 's'}.
            </p>
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

        <div className="mt-5 space-y-4">
          <div>
            <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <input
                type="checkbox"
                checked={walletEnabled}
                onChange={(event) => setWalletEnabled(event.target.checked)}
              />
              Update Wallet
            </label>
            {walletEnabled && (
              <div className="mt-1.5">
                <SearchableCombobox
                  value={wallet}
                  onChange={setWallet}
                  options={walletOptions}
                  placeholder="Select wallet"
                />
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <input
                type="checkbox"
                checked={remarksEnabled}
                onChange={(event) => setRemarksEnabled(event.target.checked)}
              />
              Update Remarks
            </label>
            {remarksEnabled && (
              <div className="mt-1.5">
                <SearchableCombobox
                  value={remarks}
                  onChange={setRemarks}
                  options={remarksSuggestions}
                  allowCustom
                  placeholder="Select or type remarks"
                />
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <input
                type="checkbox"
                checked={dateEnabled}
                onChange={(event) => setDateEnabled(event.target.checked)}
              />
              Update Date
            </label>
            {dateEnabled && (
              <div className="mt-1.5">
                <DateInput value={date} onChange={setDate} />
              </div>
            )}
          </div>

          {!hasAnyFieldEnabled && (
            <p className="text-[11px] text-muted-foreground">Choose at least one field to update.</p>
          )}
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
            onClick={handleApplyClick}
            disabled={!canApply}
            className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${primaryButtonClassName}`}
          >
            Apply to {selectedCount} Record{selectedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
