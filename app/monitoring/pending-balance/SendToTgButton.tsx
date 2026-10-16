'use client';

// "Send to TG" for the Discrepancy Summary tab — button + confirmation
// pop-up + progress + result summary, all self-contained since it only
// renders while that tab is open (see page.tsx). Admin-only, both here
// (hides the button) and server-side (every route it calls 403s non-admins
// regardless).
import { useEffect, useRef, useState } from 'react';
import {
  Send,
  Loader2,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  Image as ImageIcon,
  FileText,
} from 'lucide-react';
import type { LeaderSendPreview, LineOutcome, DiscrepancyTgThresholds } from '@/app/lib/discrepancyTgSendPlan';

// Same icon-button shell as the Dashboard's own "Send to Telegram" button
// (app/page.tsx) — duplicated locally per this session's own convention for
// small shared styling (that button isn't an exported component either).
const SEND_BUTTON =
  'flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-[#6B7280] hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)] disabled:opacity-50 dark:text-[#9198AC]';

type PreviewResponse = { leaders: LeaderSendPreview[]; totalMessages: number; thresholds: DiscrepancyTgThresholds; hasToken: boolean };
type MessageKind = 'photos' | 'pdf';
type SentEntry = { leader: string; line: 'cashout' | 'sendmoney'; kind: MessageKind; count: number };
type FailedEntry = { leader: string; line: 'cashout' | 'sendmoney'; kind: MessageKind; reason: string };
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
  current?: { leader: string; line: 'cashout' | 'sendmoney'; kind: MessageKind };
};

// "~45s left" / "~1m 20s left" — whole seconds only, matching the plan's
// own "Remaining time only" copy. Never shown for an ETA under a second
// away or a non-finite estimate (caller gates that).
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `~${minutes}m ${seconds}s left` : `~${seconds}s left`;
}

// "Completed in 12s" / "Completed in 1m 20s" — the result screen's own
// duration caption, same whole-seconds convention as formatRemaining above
// but without the "~"/"left" wording (this one is a fact, not an estimate).
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// First letter of up to the first two words — "JAVED" -> "JA", "MR LEE" ->
// "ML" — for the Sent-details avatar chip, same convention as the Account
// menu's own initials badge elsewhere in the app.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function KindTag({ kind, children }: { kind: MessageKind; children: React.ReactNode }) {
  const isPdf = kind === 'pdf';
  return (
    <span
      className={`mr-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold ${
        isPdf
          ? 'bg-[color:var(--dd-neg)]/10 text-[color:var(--dd-neg)]'
          : 'bg-[#dbe6ff] text-[#1e3a8a] dark:bg-[#1E2140] dark:text-[#A5B4FC]'
      }`}
    >
      {children}
    </span>
  );
}

// One leader+line cell in the preview table — section 6.1's own four
// variations: nothing to send, PDF-only (0 shops reached the threshold),
// photos only (<=30 above, no PDF needed), or photos plus the Full Shop
// List PDF (31+ above).
function LineCell({ line }: { line: LineOutcome }) {
  if (line.kind === 'none') return <span className="text-muted-foreground">No positive shops</span>;
  const target = line.routedTo === 'own' ? null : 'same group';
  const targetNode = target ? (
    <span className="inline-flex items-center rounded-full border border-[#DEE1E8] bg-[#F1F2F5] px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground dark:border-[#262B38] dark:bg-[#1A1E29]">
      same group
    </span>
  ) : (
    'own group'
  );

  if (line.kind === 'pdfOnly') {
    return (
      <span className="text-foreground">
        <KindTag kind="pdf">PDF only</KindTag>
        <span className="text-[color:var(--dd-neg)]">
          0 of {line.totalCount} shop{line.totalCount === 1 ? '' : 's'}
        </span>{' '}
        &rarr; {targetNode}
      </span>
    );
  }

  return (
    <span className="text-foreground">
      <KindTag kind="photos">
        {line.photoPageCount} photo{line.photoPageCount === 1 ? '' : 's'}
      </KindTag>
      {line.kind === 'photosAndPdf' && (
        <KindTag kind="pdf">
          PDF {line.totalCount} shop{line.totalCount === 1 ? '' : 's'}
        </KindTag>
      )}
      &rarr; {targetNode}
    </span>
  );
}

const STAT_TONE_CLASSES = {
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  rose: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
  slate: 'bg-[#F1F2F5] text-muted-foreground dark:bg-[#1A1E29]',
} as const;

// Soft tone-tinted card wash behind each StatTile's icon badge — keeps the
// Sent/Failed split from reading as two identical gray boxes.
const STAT_CARD_CLASSES = {
  emerald: 'border-emerald-100 bg-emerald-50/50 dark:border-emerald-500/15 dark:bg-emerald-500/5',
  rose: 'border-rose-100 bg-rose-50/50 dark:border-rose-500/15 dark:bg-rose-500/5',
  slate: 'border-[#EFF1F4] bg-[#FAFBFC] dark:border-[#1A1E29] dark:bg-[#0E1119]',
} as const;

// Soft blurred halo behind the result icon badge — the badge itself keeps
// its existing solid tone/shadow, this just adds depth behind it.
const GLOW_TONE_CLASSES = {
  emerald: 'bg-emerald-300/40 dark:bg-emerald-500/25',
  rose: 'bg-rose-300/40 dark:bg-rose-500/25',
  amber: 'bg-amber-300/40 dark:bg-amber-500/25',
} as const;

function StatTile({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: keyof typeof STAT_TONE_CLASSES;
  icon: typeof CheckCircle2;
}) {
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

// Small format chip for the Sent-details list — an icon instead of the
// preview table's plain text pill, since this list is read top-to-bottom
// per leader rather than scanned column-by-column.
function SentKindChip({ line, kind }: { line: 'cashout' | 'sendmoney'; kind: MessageKind }) {
  const Icon = kind === 'pdf' ? FileText : ImageIcon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#DEE1E8] bg-white px-2 py-1 text-[10px] font-medium text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-[#262B38] dark:bg-[#161A24]">
      <Icon size={10} className={kind === 'pdf' ? 'text-[color:var(--dd-neg)]' : 'text-[#3B5BDB] dark:text-[#A5B4FC]'} />
      {line === 'cashout' ? 'Cashout' : 'Send Money'} &middot; {kind === 'pdf' ? 'PDF' : 'Photos'}
    </span>
  );
}

// Collapsed by default, same disclosure convention the old Skipped list
// used — grouped by leader (one leader can appear with up to 4 chips: both
// lines, each possibly photos AND pdf) so "JAVED" reads as one row, not
// up to four.
function SentList({ items }: { items: SentEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const byLeader = new Map<string, { line: 'cashout' | 'sendmoney'; kind: MessageKind }[]>();
  for (const item of items) {
    const lines = byLeader.get(item.leader) ?? [];
    lines.push({ line: item.line, kind: item.kind });
    byLeader.set(item.leader, lines);
  }

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
          <span className="rounded-full bg-[#F1F2F5] px-1.5 py-0.5 text-[9.5px] font-bold text-muted-foreground dark:bg-[#1A1E29]">
            {byLeader.size}
          </span>
        </span>
        <ChevronDown size={13} className={`shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="dt-step-fade-in divide-y divide-[#EFF1F4] border-t border-[#EFF1F4] dark:divide-[#1A1E29] dark:border-[#1A1E29]">
          {Array.from(byLeader.entries()).map(([leader, lines]) => (
            <div
              key={leader}
              className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-[#FAFBFC] dark:hover:bg-[#161A24]"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ui-accent-soft)] text-[10px] font-bold text-[var(--ui-accent)]">
                  {initials(leader)}
                </div>
                <span className="truncate text-[12.5px] font-semibold text-foreground">{leader}</span>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {lines.map((l, i) => (
                  <SentKindChip key={i} line={l.line} kind={l.kind} />
                ))}
              </div>
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
        className="max-h-[80vh] w-full max-w-[680px] overflow-y-auto rounded-xl border border-[#DEE1E8] bg-white p-5 shadow-2xl dark:border-[#262B38] dark:bg-[#12151D]"
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
                      <p className="mt-1 max-w-sm text-[12px] text-[color:var(--dd-neg)]">TG Token is invalid — check Settings &rarr; Discrepancy TG.</p>
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

            {result.failed.length > 0 && (
              <div className="mt-4 space-y-1.5 text-left">
                <p className="text-[10.5px] font-bold uppercase tracking-wide text-[color:var(--dd-neg)]">Failed</p>
                {result.failed.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-[10px] border border-[color:var(--dd-neg)]/25 bg-[color:var(--dd-neg)]/5 px-3 py-2"
                  >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[color:var(--dd-neg)]" />
                    <p className="text-[12px] text-[color:var(--dd-neg)]">
                      <span className="font-semibold">
                        {f.leader} {f.line === 'cashout' ? 'Cashout' : 'Send Money'} ({f.kind === 'pdf' ? 'PDF' : 'Photos'})
                      </span>{' '}
                      &mdash; {f.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}

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
              <h3 className="text-[15px] font-bold text-foreground">Send Discrepancy Summary to TG</h3>
              {canClose && (
                <button onClick={onCancel} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              )}
            </div>
            <p className="mb-4 text-[12px] text-muted-foreground">
              Only leaders with a TG ID in Settings &rarr; Discrepancy TG are listed. Photos show shops at or above the threshold; the Full Shop
              List PDF always has every shop.
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
                        Leader
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-left text-[10.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Cashout (&ge; {preview.thresholds.cashout.toLocaleString('en-US')})
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-left text-[10.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Send Money (&ge; {preview.thresholds.sendmoney.toLocaleString('en-US')})
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.leaders.map((l) => (
                      <tr key={l.leader} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                        <td className="px-3 py-2 font-medium text-foreground">{l.leader}</td>
                        <td className="px-3 py-2">
                          <LineCell line={l.cashout} />
                        </td>
                        <td className="px-3 py-2">
                          <LineCell line={l.sendmoney} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sending && progress && (
              <div className="mt-4 rounded-[12px] border border-[#EFF1F4] bg-[#FAFBFC] p-3.5 dark:border-[#1A1E29] dark:bg-[#0E1119]">
                {progress.current && (
                  <div className="mb-2.5 flex items-center gap-1.5 text-[12px]">
                    <Loader2 size={12} className="shrink-0 animate-spin text-[var(--ui-accent)]" />
                    <span className="truncate font-semibold text-foreground">{progress.current.leader}</span>
                    <span className="truncate text-muted-foreground">
                      &middot; {progress.current.line === 'cashout' ? 'Cashout' : 'Send Money'}
                    </span>
                    <KindTag kind={progress.current.kind}>{progress.current.kind === 'pdf' ? 'PDF' : 'Photos'}</KindTag>
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

export default function SendToTgButton() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<SendOutcome | null>(null);
  // Wall-clock duration of the run that just finished, captured once at
  // 'done' time (not recomputed afterward) — purely a display caption on
  // the result screen ("completed in 12s"), not part of SendOutcome's own
  // server-returned shape.
  const [resultDurationMs, setResultDurationMs] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Wall-clock start of the current send, for the elapsed-time-based ETA
  // below — a ref (not state) since writing it must never itself trigger a
  // re-render.
  const sendStartedAtRef = useRef<number | null>(null);
  // The ETA re-synced from the server's own progress ticks — {ms, setAt}
  // captured at the moment it was computed, so it can be counted DOWN
  // continuously below rather than sitting frozen between ticks (a tick
  // only arrives once per completed message, which can be 30s+ apart for a
  // large PDF — confirmed live: the number visibly never moved for that
  // whole stretch). A plain ref (not state) since recomputing it doesn't
  // itself need to trigger a render — the ticking clock below does that.
  const etaBaselineRef = useRef<{ ms: number; setAt: number; forSentMessages: number } | null>(null);
  // Forces a re-render once a second while sending, purely so the derived
  // "time left" text below recomputes against the live clock — this state
  // value itself is never read.
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
          fetch(`/api/configurations/discrepancy-tg?t=${Date.now()}`)
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
      const res = await fetch(`/api/configurations/discrepancy-tg/preview?t=${Date.now()}`);
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
      const res = await fetch('/api/configurations/discrepancy-tg/send', { method: 'POST' });
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
    // Token might have just been used for the first time — re-check isn't
    // necessary (saving a token doesn't require re-sending), nothing to
    // refresh here beyond closing.
  }

  if (!isAdmin) return null;

  const disabled = hasToken === false;

  const progressPercent = progress && progress.totalMessages > 0 ? Math.round((progress.sentMessages / progress.totalMessages) * 100) : null;

  // Simple linear extrapolation from elapsed-time-so-far / messages-done-
  // so-far, same convention as any standard progress-bar ETA — but
  // re-synced into `etaBaselineRef` only when a NEW server tick actually
  // arrives (progress.sentMessages changes), then counted down live every
  // second afterward via forceClockTick, rather than sitting frozen
  // between ticks for however long the next message takes to render.
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
        title={disabled ? 'Set the TG Token in Settings → Discrepancy TG first' : 'Send to TG'}
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
