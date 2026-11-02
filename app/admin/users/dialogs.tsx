'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Users, X, type LucideIcon } from 'lucide-react';
import {
  MODAL_CARD_CLASS,
  MODAL_DESTRUCTIVE_BUTTON_SHAPE_CLASS,
  MODAL_GHOST_BUTTON_CLASS,
  MODAL_GLYPH_CLASS,
  MODAL_GLYPH_STYLE,
  MODAL_INPUT_FOCUS_CLASS,
  MODAL_OVERLAY_CLASS,
  MODAL_PRIMARY_BUTTON_SHAPE_CLASS,
} from '@/app/components/modalTheme';

export const inputClass = `h-9 w-full rounded-[10px] border border-border bg-white px-3 text-[12.5px] text-foreground outline-none dark:bg-[#1c1c22] ${MODAL_INPUT_FOCUS_CLASS}`;

export function Modal({
  title,
  icon: Icon = Users,
  onClose,
  busy,
  children,
  wide,
}: {
  title: string;
  icon?: LucideIcon;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={MODAL_OVERLAY_CLASS(false)} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={MODAL_CARD_CLASS(false, wide ? 'max-w-[520px]' : undefined)}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
              <Icon size={16} />
            </span>
            <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
          </div>
          <button type="button" onClick={() => !busy && onClose()} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ModalActions({
  onCancel,
  onConfirm,
  confirmLabel,
  busy,
  destructive,
  disabled,
  submit,
}: {
  onCancel: () => void;
  onConfirm?: () => void;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  submit?: boolean;
}) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      <button type="button" onClick={onCancel} className={MODAL_GHOST_BUTTON_CLASS} disabled={busy}>
        Cancel
      </button>
      <button
        type={submit ? 'submit' : 'button'}
        onClick={onConfirm}
        disabled={busy || disabled}
        className={destructive ? `${MODAL_DESTRUCTIVE_BUTTON_SHAPE_CLASS} bg-rose-600` : MODAL_PRIMARY_BUTTON_SHAPE_CLASS}
        style={destructive ? undefined : { background: 'var(--product-accent)' }}
      >
        {busy && <Loader2 size={13} className="animate-spin" />}
        {confirmLabel}
      </button>
    </div>
  );
}

export function FormField({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold text-foreground">{label}</label>
      {children}
      {error ? (
        <p role="alert" className="mt-1 text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// After Add user / Reset password — the first-login password is the
// username; the user is held on Change Password until they set their own.
export function TempPasswordModal({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={MODAL_OVERLAY_CLASS(false)}>
      <div role="dialog" aria-modal="true" aria-label="First-login password" className={MODAL_CARD_CLASS(false)}>
        <div className="mb-4 flex items-center gap-2.5">
          <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
            <KeyRound size={16} />
          </span>
          <h2 className="text-[15px] font-bold text-foreground">First-login password</h2>
        </div>
        <p className="text-[12.5px] text-foreground">
          <span className="font-semibold">{username}</span> logs in with their username as the password, then must set their own before opening any page.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-[10px] border border-border bg-muted/30 px-3 py-2.5">
          <span className="flex-1 select-all break-all text-[14px] font-semibold tracking-wide text-foreground">{password}</span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted dark:bg-transparent"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          Ask them to log in and change it right away — until they do, anyone who knows the username can sign in.
        </p>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className={MODAL_PRIMARY_BUTTON_SHAPE_CLASS} style={{ background: 'var(--product-accent)' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '−';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Manila',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
