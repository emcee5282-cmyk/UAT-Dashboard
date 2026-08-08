'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Shield, Settings as SettingsIcon, Clock, Lock, Check, Info, Calendar } from 'lucide-react';
import AmountInput from './AmountInput';
import SearchableCombobox from './SearchableCombobox';

// Cashout Wallet Status' unified Edit Wallet Settings modal — replaces the
// old row-wide inline edit AND the separate BulkEditModal usage this page
// used to have, per explicit instruction that bulk edit must reuse this
// exact same component/design rather than a second, differently-shaped
// modal. "Enterprise" visual pass: two distinct cards (Status &
// Restrictions / Wallet Configuration), progressive disable driven by Main
// Reason, segmented Closure Type buttons, compact Services toggle cards.
// One component, two modes:
//  - `single`: every field visible, prefilled from the one wallet being
//    edited, Main Reason gates Closure Type/Services/Remarks until set,
//    required-field validation blocks Save.
//  - `bulk`: same fields/cards, but each is checkbox-gated ("Update X")
//    exactly like BulkEditModal's own established pattern (app/components/
//    BulkEditModal.tsx) — unchecked by default, no progressive-disable or
//    required-field validation (bulk edits are deliberately partial by
//    design), only checked fields are sent.
// Priority is intentionally NOT a field here — dropped per the real design
// reference, which has no Priority field at all.

export type MainReason = '' | 'Closed by Operations' | 'High Running Balance' | 'Reduce as per Leader' | 'Wallet Issue' | 'Blocked by Wallet Office' | 'Others';
export type ClosureType = '' | 'Temporary Close' | 'Permanent Close';
export type AffectedService = 'Deposit' | 'Withdrawal';
export type ScheduleOverride = '' | 'Day' | 'Extended' | 'Early Ext.' | '24/7';

// minimumAmountCanTake/balanceLimitOverride are raw digit strings
// (AmountInput's own value shape) — '' means "unset", matching the sheet/
// API's own null-means-unset convention. Converted to number | null right
// before the API call.
export type WalletSettingsValues = {
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  remark: string;
  minimumAmountCanTake: string;
  balanceLimitOverride: string;
  scheduleOverride: ScheduleOverride;
};

export const DEFAULT_WALLET_SETTINGS_VALUES: WalletSettingsValues = {
  mainReason: '',
  closureType: '',
  affectedServices: [],
  remark: '',
  minimumAmountCanTake: '',
  balanceLimitOverride: '',
  scheduleOverride: '',
};

// Kept as the earlier, confirmed 5-option list — the newer 7-option
// wording ("Wallet Maintenance", "Merchant Request", etc.) elsewhere was
// explicitly NOT adopted; this list is what's actually stored/read.
const MAIN_REASON_OPTIONS: MainReason[] = ['Closed by Operations', 'High Running Balance', 'Reduce as per Leader', 'Wallet Issue', 'Blocked by Wallet Office', 'Others'];
const CLOSURE_TYPE_OPTIONS: { value: ClosureType; label: string; icon: typeof Clock }[] = [
  { value: 'Temporary Close', label: 'Temporary Close', icon: Clock },
  { value: 'Permanent Close', label: 'Permanent Close', icon: Lock },
];
const AFFECTED_SERVICE_OPTIONS: { value: AffectedService; label: string }[] = [
  { value: 'Deposit', label: 'Deposit' },
  { value: 'Withdrawal', label: 'Withdrawal' },
];
const SCHEDULE_OPTIONS: { value: ScheduleOverride; label: string }[] = [
  { value: '', label: 'Auto (based on Leader)' },
  { value: 'Day', label: 'Day Shift (7:00 AM – 10:00 PM)' },
  { value: 'Extended', label: 'Extended (7:00 AM – 11:00 PM)' },
  { value: 'Early Ext.', label: 'Early Ext. (6:00 AM – 12:00 AM)' },
  { value: '24/7', label: '24/7 (Open 24 Hours)' },
];

const INPUT_CLASS = 'h-12 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-[13px] text-foreground outline-none transition-colors focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#1c1c1e]';
const HELP_TEXT_CLASS = 'mt-1.5 text-[11px] text-muted-foreground';

// Reusable enterprise card shell — icon in a tinted circle, title, subtitle,
// then its own fields. Both cards share this exact shell so left/right stay
// visually matched (equal padding/radius/border) regardless of content
// length.
function SettingsCard({ icon: Icon, iconBg, iconColor, title, subtitle, children }: {
  icon: typeof Shield;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white p-6 dark:border-[#3a3a3d] dark:bg-[#232326]">
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconBg}`}>
          <Icon size={20} className={iconColor} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-bold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="mt-6 space-y-5">{children}</div>
    </div>
  );
}

type FieldKey = keyof WalletSettingsValues;
const ALL_FIELD_KEYS: FieldKey[] = ['mainReason', 'closureType', 'affectedServices', 'remark', 'minimumAmountCanTake', 'balanceLimitOverride', 'scheduleOverride'];

// Single mode: plain label + control, no checkbox. Bulk mode: checkbox +
// "Update {label}" — control only renders once checked, matching
// BulkEditModal's exact existing pattern so bulk edit reads the same way
// everywhere else in the app.
function FieldRow({ label, required, bulk, enabled, onToggle, children }: {
  label: string;
  required?: boolean;
  bulk: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  if (!bulk) {
    return (
      <div>
        <label className="mb-1.5 flex items-center text-[13px] font-semibold text-foreground">
          {label}{required && <span className="ml-0.5 text-rose-500">*</span>}
        </label>
        {children}
      </div>
    );
  }
  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
        Update {label}
      </label>
      {enabled && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

type BaseProps = {
  isOpen: boolean;
  onClose: () => void;
  saving: boolean;
  errorMessage: string | null;
};

type SingleModeProps = BaseProps & {
  mode: 'single';
  shopName: string;
  initialValues: WalletSettingsValues;
  // Shown in the header as "Last updated {date} by {name}" — omitted
  // entirely (no line rendered) if updatedAt is empty (never saved yet).
  lastUpdatedAt: string;
  lastUpdatedBy: string;
  onSave: (values: WalletSettingsValues) => void;
};

type BulkModeProps = BaseProps & {
  mode: 'bulk';
  selectedCount: number;
  onSaveBulk: (updates: Partial<WalletSettingsValues>) => void;
};

type WalletSettingsModalProps = SingleModeProps | BulkModeProps;

const EMPTY_ENABLED: Record<FieldKey, boolean> = Object.fromEntries(ALL_FIELD_KEYS.map((k) => [k, false])) as Record<FieldKey, boolean>;

// "July 22, 2026 at 2:35 PM" — Manila wall clock, same convention as the
// Remarks tooltip's own formatRemarkTimestamp (app/wallet-status/page.tsx).
function formatLastUpdated(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

export default function WalletSettingsModal(props: WalletSettingsModalProps) {
  const { isOpen, onClose, saving, errorMessage, mode } = props;

  const [values, setValues] = useState<WalletSettingsValues>(DEFAULT_WALLET_SETTINGS_VALUES);
  // Bulk mode only — which fields are opted in to this save.
  const [enabled, setEnabled] = useState<Record<FieldKey, boolean>>(EMPTY_ENABLED);
  // Same open/close animation-lag pattern as RecordFormModal/BulkEditModal
  // — the closing fade/scale actually gets to play.
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValues(mode === 'single' ? props.initialValues : DEFAULT_WALLET_SETTINGS_VALUES);
      setEnabled(EMPTY_ENABLED);
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

  const isBulk = mode === 'bulk';
  const hasAnyFieldEnabled = ALL_FIELD_KEYS.some((k) => enabled[k]);
  // Progressive disable — Closure Type/Services/Remarks stay locked until a
  // Main Reason is chosen. Bulk mode skips this entirely: each field is
  // independently opt-in via its own checkbox regardless of the others.
  const dependentsUnlocked = isBulk || values.mainReason !== '';
  // Closure Type/Services are only required if a Main Reason was actually
  // picked (an incomplete restriction — reason given but no closure type/
  // services — shouldn't be savable). Wallet Configuration (Minimum
  // Amount/Balance Limit/Schedule) is completely independent of Status &
  // Restrictions — leaving Main Reason blank must never block saving
  // changes made only on that side, per explicit correction: a save was
  // getting blocked even though only Wallet Configuration fields had
  // actually changed.
  const singleModeValid = !isBulk && (values.mainReason === '' || (values.closureType !== '' && values.affectedServices.length > 0));
  const canSave = !saving && (isBulk ? hasAnyFieldEnabled : singleModeValid);

  const handleMainReasonChange = (next: MainReason) => {
    // Changing the reason resets the dependent fields — per explicit
    // instruction ("Changing the main reason will reset dependent
    // fields."), unconditional so a wrong pick never leaves a stale
    // Closure Type/Services combination paired with a new reason.
    setValues((c) => ({ ...c, mainReason: next, closureType: '', affectedServices: [] }));
  };

  const toggleAffectedService = (service: AffectedService, checked: boolean) => {
    setValues((c) => ({
      ...c,
      affectedServices: checked ? [...c.affectedServices, service] : c.affectedServices.filter((s) => s !== service),
    }));
  };

  // Removing the Main Reason also clears Remarks — but only at the moment
  // of Save, never live while still editing (per explicit instruction: the
  // textarea itself is left alone as the admin types/edits, this only
  // affects what actually gets persisted once Save Changes is clicked).
  // Applies to both single mode (the reason was cleared for this one
  // wallet) and bulk mode (only when "Update Main Reason" is checked and
  // being cleared, and the admin didn't already separately provide their
  // own Remarks value via "Update Remarks").
  const handleSaveClick = () => {
    if (!canSave) return;
    if (mode === 'single') {
      const toSave = values.mainReason === '' ? { ...values, remark: '' } : values;
      props.onSave(toSave);
      return;
    }
    const updates: Partial<WalletSettingsValues> = {};
    if (enabled.mainReason) updates.mainReason = values.mainReason;
    if (enabled.closureType) updates.closureType = values.closureType;
    if (enabled.affectedServices) updates.affectedServices = values.affectedServices;
    if (enabled.remark) updates.remark = values.remark;
    if (enabled.minimumAmountCanTake) updates.minimumAmountCanTake = values.minimumAmountCanTake;
    if (enabled.balanceLimitOverride) updates.balanceLimitOverride = values.balanceLimitOverride;
    if (enabled.scheduleOverride) updates.scheduleOverride = values.scheduleOverride;
    if (enabled.mainReason && values.mainReason === '' && !enabled.remark) updates.remark = '';
    props.onSaveBulk(updates);
  };

  const dependentsDisabled = !isBulk && !dependentsUnlocked;

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4 py-8 ${closing ? 'dt-modal-overlay-out' : 'dt-modal-overlay-in'}`}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit Wallet Settings"
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-full w-full max-w-4xl flex-col rounded-2xl border border-[#E5E7EB] bg-white shadow-2xl dark:border-[#3a3a3d] dark:bg-[#1c1c1e] ${closing ? 'dt-modal-card-out' : 'dt-modal-card-in'}`}
      >
        <div className="flex items-start justify-between gap-3 px-8 pt-8">
          <div>
            <h2 className="text-[20px] font-bold text-foreground">Edit Wallet Settings</h2>
            {mode === 'single' ? (
              <p className="mt-1 text-[12px] font-normal text-muted-foreground">
                <span className="font-semibold text-foreground">{props.shopName}</span>
                {props.lastUpdatedAt && (
                  <>
                    {' · '}Last updated {formatLastUpdated(props.lastUpdatedAt)}
                    {props.lastUpdatedBy && <> by {props.lastUpdatedBy}</>}
                  </>
                )}
              </p>
            ) : (
              <p className="mt-1 text-[12px] text-muted-foreground">
                Editing {props.selectedCount} selected wallet{props.selectedCount === 1 ? '' : 's'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-8 pb-2">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <SettingsCard
              icon={Shield}
              iconBg="bg-blue-50 dark:bg-blue-500/10"
              iconColor="text-blue-600 dark:text-blue-400"
              title="Status & Restrictions"
              subtitle="Manage wallet restrictions and operational status."
            >
              <FieldRow label="Main Reason" required bulk={isBulk} enabled={enabled.mainReason} onToggle={(next) => setEnabled((c) => ({ ...c, mainReason: next }))}>
                <SearchableCombobox
                  value={values.mainReason}
                  onChange={(next) => handleMainReasonChange(next as MainReason)}
                  options={MAIN_REASON_OPTIONS}
                  placeholder="Select Main Reason"
                />
              </FieldRow>

              <div className={`space-y-5 transition-opacity duration-300 ${dependentsDisabled ? 'pointer-events-none opacity-40' : 'opacity-100'}`}>
                <FieldRow label="Closure Type" required bulk={isBulk} enabled={enabled.closureType} onToggle={(next) => setEnabled((c) => ({ ...c, closureType: next }))}>
                  <div className="grid grid-cols-2 gap-2.5">
                    {CLOSURE_TYPE_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      const selected = values.closureType === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={dependentsDisabled}
                          onClick={() => setValues((c) => ({ ...c, closureType: opt.value }))}
                          className={`flex h-12 items-center justify-center gap-2 rounded-xl border-2 text-[13px] font-semibold transition-all duration-150 disabled:cursor-not-allowed ${
                            selected
                              ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB] dark:bg-[#1e2a3d]'
                              : 'border-[#E5E7EB] bg-white text-foreground hover:-translate-y-px hover:shadow-sm dark:border-[#3a3a3d] dark:bg-[#232326]'
                          }`}
                        >
                          <Icon size={16} />
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </FieldRow>

                <FieldRow label="Services" required bulk={isBulk} enabled={enabled.affectedServices} onToggle={(next) => setEnabled((c) => ({ ...c, affectedServices: next }))}>
                  <div className="grid grid-cols-2 gap-2.5">
                    {AFFECTED_SERVICE_OPTIONS.map((opt) => {
                      const selected = values.affectedServices.includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={dependentsDisabled}
                          onClick={() => toggleAffectedService(opt.value, !selected)}
                          className={`flex h-12 items-center justify-center gap-1.5 rounded-xl border-2 text-[13px] font-semibold transition-all duration-150 disabled:cursor-not-allowed ${
                            selected
                              ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB] dark:bg-[#1e2a3d]'
                              : 'border-[#E5E7EB] bg-white text-foreground hover:-translate-y-px hover:shadow-sm dark:border-[#3a3a3d] dark:bg-[#232326]'
                          }`}
                        >
                          {selected && <Check size={15} />}
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </FieldRow>

                <FieldRow label="Remarks" bulk={isBulk} enabled={enabled.remark} onToggle={(next) => setEnabled((c) => ({ ...c, remark: next }))}>
                  <textarea
                    maxLength={500}
                    rows={5}
                    disabled={dependentsDisabled}
                    value={values.remark}
                    onChange={(event) => setValues((c) => ({ ...c, remark: event.target.value }))}
                    placeholder="Enter the reason for this change..."
                    className={`min-h-[120px] w-full resize-none rounded-xl border border-[#E5E7EB] bg-white px-3.5 py-2.5 text-[13px] text-foreground outline-none transition-colors focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#1c1c1e]`}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <p className="text-[11px] text-muted-foreground">500 character limit</p>
                    <p className="text-[11px] text-muted-foreground">{values.remark.length}/500</p>
                  </div>
                </FieldRow>

                {!isBulk && (
                  <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-2.5 dark:border-blue-900/40 dark:bg-blue-500/5">
                    <Info size={14} className="mt-0.5 shrink-0 text-blue-500" />
                    <p className="text-[11px] leading-relaxed text-blue-700 dark:text-blue-400">Changing the main reason will reset closure type and services.</p>
                  </div>
                )}
              </div>
            </SettingsCard>

            <SettingsCard
              icon={SettingsIcon}
              iconBg="bg-emerald-50 dark:bg-emerald-500/10"
              iconColor="text-emerald-600 dark:text-emerald-400"
              title="Wallet Configuration"
              subtitle="Configure wallet operating limits and availability."
            >
              <FieldRow label="Minimum Amount Can Take" bulk={isBulk} enabled={enabled.minimumAmountCanTake} onToggle={(next) => setEnabled((c) => ({ ...c, minimumAmountCanTake: next }))}>
                <AmountInput
                  value={values.minimumAmountCanTake}
                  onChange={(next) => setValues((c) => ({ ...c, minimumAmountCanTake: next }))}
                  placeholder="0.00"
                />
                <p className={HELP_TEXT_CLASS}>Minimum transaction amount allowed.</p>
              </FieldRow>

              <FieldRow label="Balance Limit" bulk={isBulk} enabled={enabled.balanceLimitOverride} onToggle={(next) => setEnabled((c) => ({ ...c, balanceLimitOverride: next }))}>
                <AmountInput
                  value={values.balanceLimitOverride}
                  onChange={(next) => setValues((c) => ({ ...c, balanceLimitOverride: next }))}
                  placeholder="Auto (leave blank)"
                />
                <p className={HELP_TEXT_CLASS}>Leave blank to use the default limit.</p>
              </FieldRow>

              <FieldRow label="Schedule" bulk={isBulk} enabled={enabled.scheduleOverride} onToggle={(next) => setEnabled((c) => ({ ...c, scheduleOverride: next }))}>
                <div className="relative">
                  <Calendar size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <select
                    value={values.scheduleOverride}
                    onChange={(event) => setValues((c) => ({ ...c, scheduleOverride: event.target.value as ScheduleOverride }))}
                    className={`${INPUT_CLASS} pl-10`}
                  >
                    {SCHEDULE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                <p className={HELP_TEXT_CLASS}>Operating hours for this wallet.</p>
              </FieldRow>
            </SettingsCard>
          </div>

          {errorMessage && <p className="mt-5 text-[12px] text-rose-600 dark:text-rose-400">{errorMessage}</p>}
          {isBulk && !hasAnyFieldEnabled && (
            <p className="mt-5 text-[11px] text-muted-foreground">Choose at least one field to update.</p>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-[#E5E7EB] px-8 py-5 dark:border-[#3a3a3d]">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-[#E5E7EB] px-5 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 dark:border-[#3a3a3d]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            disabled={!canSave}
            className="flex items-center gap-2 rounded-xl bg-[#2563EB] px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Saving...
              </>
            ) : isBulk ? (
              `Apply to ${props.selectedCount} Wallet${props.selectedCount === 1 ? '' : 's'}`
            ) : (
              'Save Changes'
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
