'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Camera, Loader2, Upload, X } from 'lucide-react';
import UserAvatar from './UserAvatar';
import AvatarCropper from './AvatarCropper';
import { MODAL_GHOST_BUTTON_CLASS, MODAL_OVERLAY_CLASS, MODAL_PRIMARY_BUTTON_SHAPE_CLASS } from './modalTheme';
import { updateSession, type ClientSession } from '@/app/lib/auth/useSession';
import { AVATAR_ACCEPT, AvatarImageError, exportAvatarCrop, loadAvatarSource, type CropRect } from '@/app/lib/avatarImage';

const READONLY_FIELD_CLASS =
  'h-10 w-full rounded-[10px] border border-border bg-muted/30 px-3 text-[12.5px] text-foreground outline-none dark:bg-white/[0.03]';

// Opened from the account menu. Photo only — name and role are read-only
// here (Admins change those on User Management). Picking a file opens the
// crop step; Apply previews the cropped photo, which is saved only on Save.
// Cancel/Esc/✕ discards it (Esc/Cancel on the crop step only leave the crop).
export default function ProfileModal({ session, onClose }: { session: ClientSession; onClose: () => void }) {
  // undefined = unchanged, string = new photo, null = removed
  const [draft, setDraft] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  // The picked file while the crop step is open.
  const [source, setSource] = useState<{ img: HTMLImageElement; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = draft === undefined ? session.avatar : draft;
  const busy = processing || saving;
  const displayName = session.name || session.username;

  const closeCrop = useCallback(() => {
    setSource((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  // Free the object URL if the modal closes mid-crop.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);
  useEffect(() => () => {
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      if (sourceRef.current) closeCrop();
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving, closeCrop]);

  const pickFile = () => fileRef.current?.click();

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProcessing(true);
    try {
      setSource(await loadAvatarSource(file));
    } catch (err) {
      setError(err instanceof AvatarImageError ? err.message : "That image couldn't be processed. Try another one.");
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const applyCrop = (crop: CropRect) => {
    if (!source) return;
    try {
      setDraft(exportAvatarCrop(source.img, crop));
    } catch (err) {
      setError(err instanceof AvatarImageError ? err.message : "That image couldn't be processed. Try another one.");
    }
    closeCrop();
  };

  const handleSave = async () => {
    if (draft === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not save your photo. Please try again.');
        return;
      }
      await updateSession({ avatar: draft });
      onClose();
    } catch {
      setError('Could not save your photo. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={MODAL_OVERLAY_CLASS(false)} onClick={() => (source ? closeCrop() : !saving && onClose())}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={source ? 'Crop photo' : 'Profile'}
        onClick={(event) => event.stopPropagation()}
        className="dt-modal-card-in relative w-full max-w-[440px] overflow-hidden rounded-[20px] border border-border bg-white shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.35)] dark:bg-[#16161d] dark:shadow-[0_0_0_1px_var(--product-accent-soft),0_20px_60px_-12px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-[15px] font-bold text-foreground">{source ? 'Crop photo' : 'Profile'}</h2>
          <button
            type="button"
            onClick={source ? closeCrop : onClose}
            disabled={saving}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {source ? (
          <AvatarCropper img={source.img} src={source.url} onCancel={closeCrop} onApply={applyCrop} />
        ) : (
        <>
        <div className="px-6 py-6">
          <div className="flex flex-col items-center">
            <div className="relative">
              <UserAvatar user={{ name: session.name, username: session.username, avatar: preview }} size={96} />
              <button
                type="button"
                onClick={pickFile}
                disabled={busy}
                aria-label={preview ? 'Change photo' : 'Upload photo'}
                className="absolute -bottom-0.5 -right-0.5 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#111827] text-white transition-transform hover:scale-105 disabled:opacity-60 dark:border-[#16161d]"
              >
                {processing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              </button>
            </div>

            <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} className="hidden" onChange={(event) => handleFile(event.target.files?.[0])} />

            <div className="mt-4 flex items-center gap-4">
              <button type="button" onClick={pickFile} disabled={busy} className={`${MODAL_GHOST_BUTTON_CLASS} inline-flex items-center gap-1.5 disabled:opacity-50`}>
                <Upload size={13} />
                {preview ? 'Change photo' : 'Upload photo'}
              </button>
              {preview && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                  disabled={busy}
                  className="text-[12px] font-medium text-rose-600 transition-colors hover:text-rose-700 disabled:opacity-50 dark:text-rose-400"
                >
                  Remove photo
                </button>
              )}
            </div>

            {!preview && <p className="mt-2.5 text-center text-[11px] text-muted-foreground">PNG, JPG or WebP · max 5MB</p>}
            {error && (
              <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
                <AlertCircle size={13} className="mt-px shrink-0" />
                {error}
              </p>
            )}
          </div>

          <div className="mt-5 space-y-3">
            <div>
              <p className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">Name</p>
              <input readOnly value={displayName} aria-label="Name" className={READONLY_FIELD_CLASS} />
            </div>
            <div>
              <p className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">Role</p>
              <input readOnly value={session.roleLabel} aria-label="Role" className={READONLY_FIELD_CLASS} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4 dark:bg-white/[0.02]">
          <button type="button" onClick={onClose} disabled={saving} className={MODAL_GHOST_BUTTON_CLASS}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={draft === undefined || busy}
            className={MODAL_PRIMARY_BUTTON_SHAPE_CLASS}
            style={{ background: '#4F46E5' }}
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            Save
          </button>
        </div>
        </>
        )}
      </div>
    </div>,
    document.body
  );
}
