'use client';

// "Send to TG" for the Unreconciled Balance tab — button + confirmation
// pop-up + progress + result summary. Same self-contained convention as
// SendToTgButton.tsx (Discrepancy Summary's own), but simpler: this
// feature is a broadcast (every configured group gets the identical image
// set), so there's no per-leader/per-line outcome table — just one row per
// group showing how many images it'll receive.
import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, X, CheckCircle2, XCircle, AlertTriangle, ChevronDown, Image as ImageIcon } from 'lucide-react';

const SEND_BUTTON =
  'flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-[#6B7280] hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)] disabled:opacity-50 dark:text-[#9198AC]';

type PreviewResponse = { groups: { groupName: string; imageCount: number }[]; totalImages: number; totalMessages: number; hasToken: boolean };
type SentEntry = { groupName: string; albumIndex: number; albumsTotal: number; count: number };
type FailedEntry = { groupName: string; albumIndex: number; albumsTotal: number; reason: string };
type SendOutcome = {
  totalMessagesSent: number;
  totalGroupsSent: number;
  sent: SentEntry[];
  failed: FailedEntry[];
  invalidToken: boolean;
};
type SendProgress = {
  sentMessages: number;
  totalMessages: number;
  current?: { groupName: string; albumIndex: number; albumsTotal: number };
};

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `~${minutes}m ${seconds}s left` : `~${seconds}s left`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const STAT_TONE_CLASSES = {
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  rose: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
} as const;
const STAT_CARD_CLASSES = {
  emerald: 'border-emerald-100 bg-emerald-50/50 dark:border-emerald-500/15 dark:bg-emerald-500/5',
  rose: 'border-rose-100 bg-rose-50/50 dark:border-rose-500/15 dark:bg-rose-500/5',
} as const;
const GLOW_TONE_CLASSES = {
  emerald: 'bg-emerald-300/40 dark:bg-emerald-500/25',
  rose: 'bg-rose-300/40 dark:bg-rose-500/25',
  amber: 'bg-amber-300/40 dark:bg-amber-500/25',
} as const;

function StatTile({ label, value, tone, icon: Icon }: { label: string; value: number; tone: keyof typeof STAT_TONE_CLASSES; icon: typeof CheckCircle2 }) {
  return (
    <div className={`flex items-center gap-2.5 rounded-[12px] border px-3 py-2.5 ${STAT_CARD_CLASSES[tone]}`}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${STAT_TONE_CLASSES[tone]}`}>
        <Icon size={14} />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-[17px] font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[10px] font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function FailedList({ items }: { items: FailedEntry[] }) {
  return (
    <div className="mt-4 space-y-1.5 text-left">
      <p className="text-[10.5px] font-bold uppercase tracking-wide text-[color:var(--dd-neg)]">Failed</p>
      {items.map((f, i) => (
        <div key={i} className="flex items-start gap-2 rounded-[10px] border border-[color:var(--dd-neg)]/25 bg-[color:var(--dd-neg)]/5 px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[color:var(--dd-neg)]" />
          <p className="text-[12px] text-[color:var(--dd-neg)]">
            <span className="font-semibold">
              {f.groupName} (album {f.albumIndex}/{f.albumsTotal})
            </span>{' '}
            &mdash; {f.reason}
          </p>
        </div>
      ))}
    </div>
  );
}

function SentList({ items }: { items: SentEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const byGroup = new Map<string, number>();
  for (const item of items) byGroup.set(item.groupName, (byGroup.get(item.groupName) ?? 0) + item.count);

  return (
    <div className="mt-4 overflow-hidden rounded-[12px] border border-[#EFF1F4] shadow-[0_1px_3px_rgba(16,24,40,0.04)] dark:border-[#1A1E29]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-[11.5px] font-semibold text-foreground transition-colors hover:bg-[#FAFBFC] dark:hover:bg-[#161A24]"
      >
        <span className="flex items-center gap-1.5">
          <CheckCircle2 size={12} className="text-emerald-500" />
          Sent — details
          <span className="rounded-full bg-[#F1F2F5] px-1.5 py-0.5 text-[9.5px] font-bold text-muted-foreground dark:bg-[#1A1E29]">{byGroup.size}</span>
        </span>
        <ChevronDown size={13} className={`shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="dt-step-fade-in divide-y divide-[#EFF1F4] border-t border-[#EFF1F4] dark:divide-[#1A1E29] dark:border-[#1A1E29]">
          {Array.from(byGroup.entries()).map(([groupName, count]) => (
            <div key={groupName} className="flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-[#FAFBFC] dark:hover:bg-[#161A24]">
              <span className="truncate text-[12.5px] font-semibold text-foreground">{groupName}</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[#DEE1E8] bg-white px-2 py-1 text-[10px] font-medium text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-[#262B38] dark:bg-[#161A24]">
                <ImageIcon size={10} className="text-[#3B5BDB] dark:text-[#A5B4FC]" />
                {count} image{count === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmModal({
  preview,
  previewLoading,
  previewError,
  sending,
  progress,
  progressPercent,
  progressEta,
  result,
  resultDurationMs,
  sendError,
  onCancel,
  onSend,
  onDone,
}: {
  preview: PreviewResponse | null;
  previewLoading: boolean;
  previewError: string | null;
  sending: boolean;
  progress: SendProgress | null;
  progressPercent: number | null;
  progressEta: string | null;
  result: SendOutcome | null;
  resultDurationMs: number | null;
  sendError: string | null;
  onCancel: () => void;
  onSend: () => void;
  onDone: () => void;
}) {
  const canClose = !sending;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4" onClick={canClose ? (result ? onDone : onCancel) : undefined}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-[560px] overflow-y-auto rounded-xl border border-[#DEE1E8] bg-white p-5 shadow-2xl dark:border-[#262B38] dark:bg-[#12151D]"
      >
        {result ? (
          <div key="result" className="dt-step-fade-in">
            {(() => {
              const hasFailures = result.failed.length > 0 || result.invalidToken;
              const totalFailure = result.totalMessagesSent === 0 && hasFailures;
              const tone = totalFailure ? 'rose' : hasFailures ? 'amber' : 'emerald';
              const Icon = totalFailure ? XCircle : hasFailures ? AlertTriangle : CheckCircle2;
              const iconWrapClass =
                tone === 'rose'
                  ? 'bg-rose-50 text-rose-600 shadow-[0_4px_14px_-2px_rgba(225,29,72,0.35)] dark:bg-rose-500/15 dark:text-rose-400'
                  : tone === 'amber'
                    ? 'bg-amber-50 text-amber-600 shadow-[0_4px_14px_-2px_rgba(217,119,6,0.35)] dark:bg-amber-500/15 dark:text-amber-400'
                    : 'bg-emerald-50 text-emerald-600 shadow-[0_4px_14px_-2px_rgba(16,185,129,0.35)] dark:bg-emerald-500/15 dark:text-emerald-400';
              return (
                <>
                  <div className="flex justify-end">
                    <button onClick={onDone} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="-mt-2 flex flex-col items-center px-2 pb-1 text-center">
                    <div className="relative flex h-[68px] w-[68px] items-center justify-center">
                      <div className={`absolute inset-0 rounded-full blur-xl ${GLOW_TONE_CLASSES[tone]}`} />
                      <div
                        className={`relative flex h-[52px] w-[52px] items-center justify-center rounded-full ring-[3px] ring-white animate-[dt-badge-pop_300ms_var(--ease-out-strong)] dark:ring-[#12151D] ${iconWrapClass}`}
                      >
                        <Icon size={22} />
                      </div>
                    </div>
                    <p className="mt-2.5 text-[16px] font-bold text-foreground">
                      {totalFailure
                        ? 'Nothing was sent'
                        : `Sent ${result.totalMessagesSent} message${result.totalMessagesSent === 1 ? '' : 's'} to ${result.totalGroupsSent} group${result.totalGroupsSent === 1 ? '' : 's'}`}
                    </p>
                    {result.invalidToken ? (
                      <p className="mt-1 max-w-sm text-[12px] text-[color:var(--dd-neg)]">TG Token is invalid — check Settings &rarr; Unreconciled TG.</p>
                    ) : (
                      <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                        Delivered via Telegram{resultDurationMs != null ? ` · completed in ${formatDuration(resultDurationMs)}` : ''}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2.5">
                    <StatTile label="Sent" value={result.totalMessagesSent} tone="emerald" icon={CheckCircle2} />
                    <StatTile label="Failed" value={result.failed.length} tone="rose" icon={AlertTriangle} />
                  </div>
                </>
              );
            })()}

            {result.failed.length > 0 && <FailedList items={result.failed} />}
            {result.sent.length > 0 && <SentList items={result.sent} />}

            <div className="mt-5 flex justify-end">
              <button
                onClick={onDone}
                className="inline-flex items-center gap-1.5 rounded-[9px] border-none bg-[#1B2129] px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]"
              >
                <CheckCircle2 size={14} />
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-1 flex items-start justify-between">
              <h3 className="text-[15px] font-bold text-foreground">Send Unreconciled Balance to TG</h3>
              {canClose && (
                <button onClick={onCancel} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              )}
            </div>
            <p className="mb-4 text-[12px] text-muted-foreground">
              Every group in Settings &rarr; Unreconciled TG receives the same images: Cashout, then Send Money, then Group Total.
            </p>

            {previewLoading && (
              <div className="flex items-center justify-center py-10 text-[13px] text-muted-foreground">
                <Loader2 size={16} className="mr-2 animate-spin" /> Building preview&hellip;
              </div>
            )}
            {previewError && <p className="py-6 text-[12.5px] text-[color:var(--dd-neg)]">{previewError}</p>}

            {preview && !previewLoading && !previewError && (
              <div className="overflow-hidden rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-left text-[10.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Group
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Images
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.groups.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="px-3 py-4 text-center text-muted-foreground">
                          No groups configured yet.
                        </td>
                      </tr>
                    ) : (
                      preview.groups.map((g) => (
                        <tr key={g.groupName} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                          <td className="px-3 py-2 font-medium text-foreground">{g.groupName}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-foreground">{g.imageCount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {sending && progress && (
              <div className="mt-4 rounded-[12px] border border-[#EFF1F4] bg-[#FAFBFC] p-3.5 dark:border-[#1A1E29] dark:bg-[#0E1119]">
                {progress.current && (
                  <div className="mb-2.5 flex items-center gap-1.5 text-[12px]">
                    <Loader2 size={12} className="shrink-0 animate-spin text-[var(--ui-accent)]" />
                    <span className="truncate font-semibold text-foreground">{progress.current.groupName}</span>
                    <span className="truncate text-muted-foreground">
                      &middot; album {progress.current.albumIndex}/{progress.current.albumsTotal}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {progress.sentMessages}/{progress.totalMessages} messages
                  </span>
                  <span className="flex items-center gap-1.5 font-semibold tabular-nums text-foreground">
                    {progressPercent ?? 0}%
                    {progressEta && <span className="font-normal text-muted-foreground">&middot; {progressEta}</span>}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[#EFF1F4] dark:bg-[#1A1E29]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[var(--ui-accent)] to-[#8B87FF] transition-[width] duration-500 ease-out"
                    style={{ width: `${progressPercent ?? 0}%` }}
                  />
                </div>
              </div>
            )}
            {sendError && <p className="mt-3 text-[12.5px] text-[color:var(--dd-neg)]">{sendError}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={onCancel}
                disabled={sending}
                className="whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] disabled:opacity-40 dark:border-[#262B38] dark:bg-[#1A1E29]"
              >
                Cancel
              </button>
              <button
                onClick={onSend}
                disabled={sending || previewLoading || !preview || preview.totalMessages === 0}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] border-none bg-[#1B2129] px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors hover:brightness-110 disabled:opacity-40 dark:bg-[#F3F4F7] dark:text-[#0A0C11]"
              >
                {sending ? <Loader2 size={13} className="animate-spin" /> : null}
                {sending ? `Sending… ${progress?.sentMessages ?? 0}/${progress?.totalMessages ?? 0} messages` : `Send ${preview?.totalMessages ?? 0} messages`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SendUnreconciledToTgButton() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<SendOutcome | null>(null);
  const [resultDurationMs, setResultDurationMs] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendStartedAtRef = useRef<number | null>(null);
  const etaBaselineRef = useRef<{ ms: number; setAt: number; forSentMessages: number } | null>(null);
  const [, forceClockTick] = useState(0);

  useEffect(() => {
    if (!sending) return;
    const interval = setInterval(() => forceClockTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [sending]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const admin = data?.role === 'admin';
        setIsAdmin(admin);
        if (admin) {
          fetch(`/api/configurations/unreconciled-tg?t=${Date.now()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => setHasToken(Boolean(data?.token)))
            .catch(() => setHasToken(false));
        }
      })
      .catch(() => setIsAdmin(false));
  }, []);

  async function openModal() {
    setModalOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setResult(null);
    setSendError(null);
    try {
      const res = await fetch(`/api/configurations/unreconciled-tg/preview?t=${Date.now()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed to build preview');
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to build preview');
    } finally {
      setPreviewLoading(false);
    }
  }

  function closeModal() {
    if (sending) return;
    setModalOpen(false);
  }

  async function handleSend() {
    setSending(true);
    setSendError(null);
    sendStartedAtRef.current = Date.now();
    setProgress({ sentMessages: 0, totalMessages: preview?.totalMessages ?? 0 });
    try {
      const res = await fetch('/api/configurations/unreconciled-tg/send', { method: 'POST' });
      if (!res.body) throw new Error('No response stream from server.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'progress') setProgress({ sentMessages: msg.sentMessages, totalMessages: msg.totalMessages, current: msg.current });
          else if (msg.type === 'done') {
            setResult(msg.outcome);
            setResultDurationMs(sendStartedAtRef.current ? Date.now() - sendStartedAtRef.current : null);
            finished = true;
          } else if (msg.type === 'error') {
            setSendError(msg.error);
            finished = true;
          }
        }
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send to TG');
    } finally {
      setSending(false);
    }
  }

  function handleDone() {
    setModalOpen(false);
    setPreview(null);
    setResult(null);
    setResultDurationMs(null);
    setProgress(null);
  }

  if (!isAdmin) return null;

  const disabled = hasToken === false;
  const progressPercent = progress && progress.totalMessages > 0 ? Math.round((progress.sentMessages / progress.totalMessages) * 100) : null;

  if (progress && progress.sentMessages > 0 && progress.sentMessages < progress.totalMessages && sendStartedAtRef.current) {
    const elapsedMs = Date.now() - sendStartedAtRef.current;
    const remainingMs = (elapsedMs / progress.sentMessages) * (progress.totalMessages - progress.sentMessages);
    if (!etaBaselineRef.current || etaBaselineRef.current.forSentMessages !== progress.sentMessages) {
      etaBaselineRef.current = { ms: remainingMs, setAt: Date.now(), forSentMessages: progress.sentMessages };
    }
  } else {
    etaBaselineRef.current = null;
  }
  const progressEta = etaBaselineRef.current
    ? formatRemaining(Math.max(0, etaBaselineRef.current.ms - (Date.now() - etaBaselineRef.current.setAt)))
    : null;

  return (
    <>
      <button
        onClick={openModal}
        disabled={disabled}
        aria-label="Send to TG"
        title={disabled ? 'Set the TG Token in Settings → Unreconciled TG first' : 'Send to TG'}
        className={SEND_BUTTON}
      >
        <Send size={11} />
      </button>
      {modalOpen && (
        <ConfirmModal
          preview={preview}
          previewLoading={previewLoading}
          previewError={previewError}
          sending={sending}
          progress={progress}
          progressPercent={progressPercent}
          progressEta={progressEta}
          result={result}
          resultDurationMs={resultDurationMs}
          sendError={sendError}
          onCancel={closeModal}
          onSend={handleSend}
          onDone={handleDone}
        />
      )}
    </>
  );
}
