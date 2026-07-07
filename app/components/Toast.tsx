'use client';

import { useEffect } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';

export type ToastState = { type: 'success' | 'error'; message: string } | null;

export default function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, 3500);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const isSuccess = toast.type === 'success';
  return (
    <div className="fixed bottom-5 right-5 z-[100] flex items-center gap-2 rounded-lg border border-border bg-white px-3.5 py-2.5 text-[12px] font-medium text-foreground shadow-lg dark:bg-[#2a2a2d]">
      {isSuccess ? (
        <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
      ) : (
        <XCircle size={15} className="shrink-0 text-rose-500" />
      )}
      {toast.message}
    </div>
  );
}
