'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, ListChecks, Check } from 'lucide-react';
import SearchableCombobox from './SearchableCombobox';
import DateInput from './DateInput';
import AmountInput from './AmountInput';
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

// Applies ONE new value to a chosen field across every selected row at
// once. Settlement/Top Up: Wallet/Remarks/Date only, per explicit spec —
// Brand/Agent Name/Amount stay out since those are effectively unique per
// record. Opening Balance has no Wallet/Date at all (a roster snapshot,
// not a per-transaction record) — its own bulk-editable set is
// Leader/Opening Balance/SDP instead. Each field is independently toggled
// ("Update Wallet") so the user can change just one, some, or all in a
// single pass — untouched fields keep each row's own value. UI-only
// prototype, same convention as RecordFormModal/BulkImportModal: onApply
// hands the caller plain field values, nothing here persists anywhere or
// knows about a database.
export type BulkEditUpdates = {
  wallet?: string;
  remarks?: string;
  // DateInput's own display format ("Jul 24, 2026") — the caller converts
  // this to its own row storage format (each Settlement page already has
  // its own raw "M/D/YYYY" convention and its own small parser for it).
  date?: string;
  leader?: string;
  openingBalance?: string;
  sdp?: string;
  // Wallet Status-only field — a fixed option list (Low/Normal/High), not
  // free text, so it renders as a <select> rather than SearchableCombobox.
  priority?: string;
};

type BulkEditModalProps = {
  isOpen: boolean;
  onClose: () => void;
  // May return a Promise — if it does, Apply awaits it, stays open with a
  // disabled/"Applying..." button until it settles, and only closes on
  // success. A thrown/rejected error is caught and shown inline instead of
  // closing (same pattern as RecordFormModal's own onSave), so a real
  // server/transaction failure can never be silently treated as a success.
  onApply: (updates: BulkEditUpdates) => void | Promise<void>;
  selectedCount: number;
  // Omit entirely for modules with no Wallet field (e.g. Opening Balance) —
  // the "Update Wallet" row simply doesn't render.
  walletOptions?: string[];
  // Omit entirely for modules with no free-text Remarks field (e.g. Top Up,
  // whose Type is a fixed literal per product, not bulk-editable like
  // Settlement's Remarks) — the "Update Remarks" row simply doesn't render.
  remarksSuggestions?: string[];
  // Shown by default (Settlement/Top Up both have a per-transaction Date) —
  // Opening Balance's caller passes false since a roster snapshot has none.
  showDateField?: boolean;
  // Opening Balance-only fields — omitted (default false) for every other
  // module. Leader is free text (no fixed option list); Opening
  // Balance/SDP are both optional amounts, matching each Opening page's own
  // blank-handling.
  showLeaderField?: boolean;
  showOpeningBalanceField?: boolean;
  showSdpField?: boolean;
  // Omit entirely for modules with no Priority field (every module except
  // Wallet Status) — the "Update Priority" row simply doesn't render.
  priorityOptions?: string[];
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
  showDateField = true,
  showLeaderField = false,
  showOpeningBalanceField = false,
  showSdpField = false,
  priorityOptions,
  primaryButtonClassName,
  dataProduct,
}: BulkEditModalProps) {
  const [walletEnabled, setWalletEnabled] = useState(false);
  const [remarksEnabled, setRemarksEnabled] = useState(false);
  const [dateEnabled, setDateEnabled] = useState(false);
  const [leaderEnabled, setLeaderEnabled] = useState(false);
  const [openingBalanceEnabled, setOpeningBalanceEnabled] = useState(false);
  const [sdpEnabled, setSdpEnabled] = useState(false);
  const [priorityEnabled, setPriorityEnabled] = useState(false);
  const [wallet, setWallet] = useState('');
  const [remarks, setRemarks] = useState('');
  const [date, setDate] = useState('');
  const [leader, setLeader] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [sdp, setSdp] = useState('');
  const [priority, setPriority] = useState('');
  // Real async-apply state (see onApply's own comment above) — both stay at
  // their default for every caller whose onApply doesn't reject.
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
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
      setLeaderEnabled(false);
      setOpeningBalanceEnabled(false);
      setSdpEnabled(false);
      setPriorityEnabled(false);
      setWallet('');
      setRemarks('');
      setDate('');
      setLeader('');
      setOpeningBalance('');
      setSdp('');
      setPriority(priorityOptions?.[0] ?? '');
      setApplying(false);
      setApplyError(null);
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

  const hasWalletField = walletOptions !== undefined;
  const hasRemarksField = remarksSuggestions !== undefined;
  const hasPriorityField = priorityOptions !== undefined;
  const hasAnyFieldEnabled = walletEnabled || remarksEnabled || dateEnabled || leaderEnabled || openingBalanceEnabled || sdpEnabled || priorityEnabled;
  // Opening Balance/SDP are genuinely optional amounts (blank is valid on
  // both products), so an enabled-but-blank value is fine for those two —
  // unlike Wallet/Remarks/Date/Leader, where enabling the field implies the
  // user wants to actually set something. Priority is always non-blank once
  // enabled — it's a <select> seeded from priorityOptions[0], never a free
  // text field a user could leave empty.
  const canApply = hasAnyFieldEnabled
    && (!walletEnabled || wallet.trim() !== '')
    && (!remarksEnabled || remarks.trim() !== '')
    && (!dateEnabled || date.trim() !== '')
    && (!leaderEnabled || leader.trim() !== '')
    && (!priorityEnabled || priority.trim() !== '');

  const handleApplyClick = async () => {
    if (!canApply) return;
    try {
      setApplying(true);
      setApplyError(null);
      await onApply({
        ...(walletEnabled ? { wallet } : {}),
        ...(remarksEnabled ? { remarks } : {}),
        ...(dateEnabled ? { date } : {}),
        ...(leaderEnabled ? { leader } : {}),
        ...(openingBalanceEnabled ? { openingBalance } : {}),
        ...(sdpEnabled ? { sdp } : {}),
        ...(priorityEnabled ? { priority } : {}),
      });
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Failed to apply changes. Please try again.');
    } finally {
      setApplying(false);
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
        role="dialog"
        aria-modal="true"
        aria-label="Bulk Edit Records"
        onClick={(event) => event.stopPropagation()}
        className={MODAL_CARD_CLASS(closing)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
              <ListChecks size={16} />
            </span>
            <div>
              <h2 className="text-[16px] font-bold text-foreground">Bulk Edit</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Applying to {selectedCount} selected record{selectedCount === 1 ? '' : 's'}.
              </p>
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

        <div className="mt-5 space-y-4">
          {hasWalletField && (
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
                    options={walletOptions ?? []}
                    placeholder="Select wallet"
                  />
                </div>
              )}
            </div>
          )}

          {hasPriorityField && (
            <div>
              <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={priorityEnabled}
                  onChange={(event) => setPriorityEnabled(event.target.checked)}
                />
                Update Priority
              </label>
              {priorityEnabled && (
                <div className="mt-1.5">
                  <select
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    className="h-10 w-full rounded-[10px] border border-border bg-white px-3.5 text-[13px] text-foreground outline-none transition-colors focus:border-[color:var(--product-accent)] focus:ring-2 focus:ring-[color:var(--product-accent-soft)] dark:bg-[#1c1c1e]"
                  >
                    {(priorityOptions ?? []).map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {showLeaderField && (
            <div>
              <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={leaderEnabled}
                  onChange={(event) => setLeaderEnabled(event.target.checked)}
                />
                Update Leader
              </label>
              {leaderEnabled && (
                <div className="mt-1.5">
                  <input
                    type="text"
                    value={leader}
                    onChange={(event) => setLeader(event.target.value)}
                    placeholder="Leader name"
                    className="h-10 w-full rounded-[10px] border border-border bg-white px-3.5 text-[13px] text-foreground outline-none transition-colors focus:border-[color:var(--product-accent)] focus:ring-2 focus:ring-[color:var(--product-accent-soft)] dark:bg-[#1c1c1e]"
                  />
                </div>
              )}
            </div>
          )}

          {showOpeningBalanceField && (
            <div>
              <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={openingBalanceEnabled}
                  onChange={(event) => setOpeningBalanceEnabled(event.target.checked)}
                />
                Update Opening Balance
              </label>
              {openingBalanceEnabled && (
                <div className="mt-1.5">
                  <AmountInput value={openingBalance} onChange={setOpeningBalance} />
                </div>
              )}
            </div>
          )}

          {showSdpField && (
            <div>
              <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={sdpEnabled}
                  onChange={(event) => setSdpEnabled(event.target.checked)}
                />
                Update SDP
              </label>
              {sdpEnabled && (
                <div className="mt-1.5">
                  <AmountInput value={sdp} onChange={setSdp} />
                </div>
              )}
            </div>
          )}

          {hasRemarksField && (
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
                    options={remarksSuggestions ?? []}
                    allowCustom
                    placeholder="Select or type remarks"
                  />
                </div>
              )}
            </div>
          )}

          {showDateField && (
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
          )}

          {!hasAnyFieldEnabled && (
            <p className="text-[11px] text-muted-foreground">Choose at least one field to update.</p>
          )}
        </div>

        {applyError && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{applyError}</span>
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
              onClick={handleApplyClick}
              disabled={!canApply || applying}
              className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${primaryButtonClassName}`}
            >
              {!applying && <Check size={13} />}
              {applying ? 'Applying...' : `Apply to ${selectedCount} Record${selectedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
