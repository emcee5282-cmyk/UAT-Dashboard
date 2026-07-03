'use client';

import { RefreshCw, ShieldAlert, WifiOff, FileQuestion, AlertCircle } from 'lucide-react';
import type { ClassifiedError, ErrorKind } from '@/app/lib/errors';

const ICONS: Record<ErrorKind, typeof AlertCircle> = {
  auth: ShieldAlert,
  network: WifiOff,
  notfound: FileQuestion,
  unknown: AlertCircle,
};

export default function ConnectionErrorState({
  error,
  onRetry,
}: {
  error: ClassifiedError;
  onRetry: () => void;
}) {
  const Icon = ICONS[error.kind];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 dark:border-rose-900/60 dark:bg-rose-500/10">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-300" />
        <div>
          <p className="text-sm font-semibold text-rose-700 dark:text-rose-200">{error.title}</p>
          <p className="mt-0.5 text-[13px] text-rose-600 dark:text-rose-300">{error.message}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 pl-[30px]">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-[12px] font-medium text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-800 dark:bg-transparent dark:text-rose-300 dark:hover:bg-rose-500/10"
        >
          <RefreshCw size={12} />
          Try Again
        </button>
        <details className="text-[11px] text-rose-500/80 dark:text-rose-400/70">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <p className="mt-1 max-w-md break-words text-[10px]">{error.detail}</p>
        </details>
      </div>
    </div>
  );
}
