'use client';

// Staff's ticket detail — left conversation / right info panel, in the
// same main-pane area the table (page.tsx) occupies (Next.js swaps this
// sibling route in, see layout.tsx — no more persistent side panel).
//
// Restyled to match a settlement-mockup reference: back-link header with
// leader name as the primary heading, avatar+name message bubbles, a
// stacked-field details card, a 2-action settle panel, and a dot-timeline
// status history. Workflow behavior added alongside the restyle (per
// explicit instruction, not implied by the visual reference alone):
// Pending auto-advances to Ongoing on a staff reply (see POST
// .../messages), Settled requires an extra confirm step (ConfirmSettleModal
// below) and is terminal — enforced both here (buttons hidden) and
// server-side (PATCH .../status, POST .../messages both reject once
// settled) so a stale tab can't bypass it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, ImagePlus, Loader2, Moon, RefreshCw, Send, Sun, X } from 'lucide-react';
import { useVisibilityPolling } from '@/app/lib/useVisibilityPolling';
import { useTheme } from '@/app/components/ThemeProvider';
import AccountMenu from '@/app/components/AccountMenu';
import { MODAL_OVERLAY_CLASS, MODAL_CARD_CLASS, MODAL_GHOST_BUTTON_CLASS, MODAL_PRIMARY_BUTTON_SHAPE_CLASS, MODAL_ESC_HINT_CLASS, MODAL_ESC_KBD_CLASS } from '@/app/components/modalTheme';

type TicketDetail = {
  id: number;
  title: 'agent_concern' | 'shop_replacement' | 'adding_new_account';
  issueType: string | null;
  agentCodes: string[];
  shopCodes: string[];
  dailyLimit: string | null;
  limitDuration: 'day_shift' | '24_hours' | null;
  numShops: number | null;
  details: string | null;
  status: 'pending' | 'ongoing' | 'settled' | 'rejected';
  createdAt: string;
  leaderName: string | null;
  submittedByUsername: string | null;
  // Read-receipt source — see receiptFor() below. Both are visible to both
  // roles (unlike the assignee-name redaction elsewhere): each side needs
  // the OTHER side's viewed-at to compute its own "Seen"/"Delivered".
  lastViewedAt: string | null;
  staffLastViewedAt: string | null;
};

type Message = {
  id: number;
  senderId: number;
  senderRole: 'leader' | 'staff' | 'system';
  senderName: string | null;
  message: string;
  kind: string | null;
  attachmentData: string | null;
  attachmentMimeType: string | null;
  attachmentName: string | null;
  createdAt: string;
};

const TITLE_LABEL: Record<TicketDetail['title'], string> = {
  agent_concern: 'Agent concern',
  shop_replacement: 'Shop replacement',
  adding_new_account: 'Adding new account',
};

const DURATION_LABEL: Record<string, string> = { day_shift: 'Day shift', '24_hours': '24 hours' };

const STATUS_META: Record<TicketDetail['status'], { label: string; badgeClassName: string; dotClassName: string }> = {
  pending: { label: 'Pending', badgeClassName: 'bg-amber-50 text-amber-700 border-amber-200', dotClassName: 'bg-amber-500' },
  ongoing: { label: 'Ongoing', badgeClassName: 'bg-blue-50 text-blue-700 border-blue-200', dotClassName: 'bg-blue-500' },
  settled: { label: 'Settled', badgeClassName: 'bg-emerald-50 text-emerald-700 border-emerald-200', dotClassName: 'bg-emerald-500' },
  // Red reserved exclusively for Rejected — matches container-color-spec.html's
  // own rule ("the only red fill in the whole UI").
  rejected: { label: 'Rejected', badgeClassName: 'bg-rose-50 text-rose-700 border-rose-200', dotClassName: 'bg-rose-500' },
};

// Tagging mirrors the list page's own derivation (app/staff/tickets/page.tsx)
// — kept as a local copy rather than a shared import, matching how that
// page's own TAG_META/STATUS_STYLE constants are already scoped per-file.
type Tag = 'OPS' | 'ACC';
// Colors from container-color-spec.html's tag-chip mapping: Operations Team
// -> --accent-soft (blue tint), Account Team -> --purple-soft — tinted fill,
// no border, matching every other chip in that spec.
const TAG_META: Record<Tag, { label: string; className: string; dotClassName: string }> = {
  OPS: { label: 'Operations Team', className: 'bg-[#2E6BDB14] text-[#2E6BDB] dark:bg-[#4E8BF01A] dark:text-[#4E8BF0] border-transparent', dotClassName: 'bg-[#2E6BDB] dark:bg-[#4E8BF0]' },
  ACC: { label: 'Account Team', className: 'bg-[#6E5FC214] text-[#6E5FC2] dark:bg-[#8B7CD81A] dark:text-[#8B7CD8] border-transparent', dotClassName: 'bg-[#6E5FC2] dark:bg-[#8B7CD8]' },
};
function getTag(t: TicketDetail): Tag {
  return t.title === 'agent_concern' ? 'OPS' : 'ACC';
}

const POLL_INTERVAL_MS = 4500;
const NEAR_BOTTOM_THRESHOLD_PX = 120;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function lastMessageBy(messages: Message[], role: 'leader' | 'staff'): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderRole === role) return messages[i];
  }
  return null;
}

function receiptFor(message: Message | null, viewedAt: string | null): 'seen' | 'delivered' | null {
  if (!message) return null;
  if (!viewedAt) return 'delivered';
  return new Date(viewedAt) > new Date(message.createdAt) ? 'seen' : 'delivered';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type HistoryEntry = { label: string; timestamp: string; actor: string };

// Status changes are logged as 'system' ticket_messages rows (see PATCH
// /api/tickets/:id/status and the auto-transition in POST .../messages,
// which reuses this exact same 'assigned'-kind convention), not a separate
// history table — derived here rather than adding a new persisted field.
// The source strings are fully controlled server-side, so parsing them
// back is safe/deterministic.
function deriveStatusHistory(ticket: TicketDetail, messages: Message[]): HistoryEntry[] {
  // (leader)/(staff) suffix on each actor — every entry past "Submitted" is
  // necessarily staff-driven (PATCH .../status and the reply auto-transition
  // are both staff/admin-only), so the role is a static label, not something
  // that needs to travel with the parsed name itself.
  const entries: HistoryEntry[] = [{ label: 'Submitted', timestamp: ticket.createdAt, actor: `${ticket.leaderName ?? 'Leader'} (leader)` }];
  for (const m of messages) {
    if (m.senderRole !== 'system') continue;
    if (m.kind === 'assigned') {
      const actor = m.message.match(/assigned to (.+)\.$/)?.[1] ?? 'Staff';
      entries.push({ label: 'Ongoing', timestamp: m.createdAt, actor: `${actor} (staff)` });
      continue;
    }
    const match = m.message.match(/^Status changed to (.+) by (.+)\.$/);
    if (match) entries.push({ label: match[1], timestamp: m.createdAt, actor: `${match[2]} (staff)` });
  }
  return entries;
}

export default function StaffTicketDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { theme, toggleTheme } = useTheme();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<{ name: string; file: File } | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirmSettleOpen, setConfirmSettleOpen] = useState(false);
  const [confirmRejectOpen, setConfirmRejectOpen] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const threadContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasNearBottomRef = useRef(true);

  const loadTicket = useCallback(() => {
    return fetch(`/api/tickets/${params.id}`)
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!res.ok) throw new Error('Failed to load ticket');
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        setTicket((prev) => {
          const next = data.ticket as TicketDetail;
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
          return next;
        });
        setMessages((prev) => {
          const next = (data.messages ?? []) as Message[];
          if (prev.length === next.length && prev.every((m, i) => m.id === next[i]?.id)) return prev;
          return next;
        });
      })
      .catch(() => setLoadError('Could not load this ticket. Try refreshing the page.'));
  }, [params.id]);

  useEffect(() => {
    loadTicket();
  }, [loadTicket]);

  useVisibilityPolling(loadTicket, POLL_INTERVAL_MS);

  useEffect(() => {
    if (wasNearBottomRef.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  function handleThreadScroll() {
    const el = threadContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
  }

  function markViewed() {
    fetch(`/api/tickets/${params.id}/view`, { method: 'POST' }).catch(() => {});
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAttachment({ name: file.name, file });
    const reader = new FileReader();
    reader.onload = () => setAttachmentPreviewUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function handleSend() {
    const text = draft.trim();
    if ((!text && !attachment) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const body: Record<string, unknown> = { message: text };
      if (attachment) {
        body.attachmentData = await fileToBase64(attachment.file);
        body.attachmentMimeType = attachment.file.type;
        body.attachmentName = attachment.name;
      }
      const res = await fetch(`/api/tickets/${params.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendError(data.error || 'Could not send your message.');
        setSending(false);
        return;
      }
      wasNearBottomRef.current = true;
      setMessages((prev) => [...prev, data.message, ...(data.statusLogMessage ? [data.statusLogMessage] : [])]);
      if (data.autoStatus) {
        setTicket((prev) => (prev ? { ...prev, status: data.autoStatus } : prev));
      }
      setDraft('');
      setAttachment(null);
      setAttachmentPreviewUrl(null);
      setSending(false);
    } catch {
      setSendError('Could not send your message.');
      setSending(false);
    }
  }

  async function handleStatusChange(status: TicketDetail['status']) {
    if (!ticket || status === ticket.status || statusUpdating) return;
    setStatusUpdating(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/tickets/${params.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not update status.');
      }
      setTicket((prev) => (prev ? { ...prev, status } : prev));
      setMessages((prev) => [...prev, data.message]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update status.';
      setStatusError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setStatusUpdating(false);
    }
  }

  // Rejecting sends the leader a real explanatory message (not just a short
  // system audit line) and closes the ticket, so it goes through its own
  // POST .../reject endpoint rather than PATCH .../status — see that
  // route's own comment.
  async function handleReject() {
    if (!ticket || statusUpdating) return;
    setStatusUpdating(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/tickets/${params.id}/reject`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not reject this ticket.');
      }
      setTicket((prev) => (prev ? { ...prev, status: 'rejected' } : prev));
      setMessages((prev) => [...prev, data.message, ...(data.statusLogMessage ? [data.statusLogMessage] : [])]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not reject this ticket.';
      setStatusError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setStatusUpdating(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-xl border border-border bg-white p-8 text-center">
          <p className="text-sm font-bold text-foreground">Ticket not found</p>
          <button type="button" onClick={() => router.push('/staff/tickets')} className="mt-6 rounded-lg bg-foreground px-4 py-2.5 text-xs font-bold text-background">
            Back to tickets
          </button>
        </div>
      </div>
    );
  }

  const lastStaffMessage = lastMessageBy(messages, 'staff');
  const lastLeaderMessage = lastMessageBy(messages, 'leader');
  const staffMessageReceipt = receiptFor(lastStaffMessage, ticket?.lastViewedAt ?? null);
  const leaderMessageReceipt = receiptFor(lastLeaderMessage, ticket?.staffLastViewedAt ?? null);
  const isRejected = ticket?.status === 'rejected';
  const closed = ticket?.status === 'settled' || isRejected;
  const statusMeta = ticket ? STATUS_META[ticket.status] : null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden px-4 pb-6 md:px-[28px] md:pb-8">
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col overflow-hidden">
        {/* Standalone top header, always visible (even mid-load) — breadcrumb
            title left, utility icons right, matching the list page's own
            header row (app/staff/tickets/page.tsx). "Back to queue" is its
            own block below, not part of this row. */}
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-border pb-[14px] pt-14 md:pt-[14px]">
          <div className="min-w-0">
            {/* Breadcrumb-style title — "Tickets" (muted, the section)
                followed by the specific ticket id (normal weight, the
                actual header value). */}
            <h1 className="truncate text-[14px] font-bold leading-tight">
              <span className="font-medium text-muted-foreground">Tickets</span>
              <span className="font-medium text-muted-foreground"> / </span>
              <span className="text-foreground">{ticket ? `TCK-${ticket.id}` : ''}</span>
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => loadTicket()}
              aria-label="Refresh"
              title="Refresh"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-foreground hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)]"
            >
              <RefreshCw size={11} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle light and dark mode"
              title="Toggle light and dark mode"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] dark:border-[#262B38] bg-[#F1F2F5] dark:bg-[#1A1E29] text-foreground hover:text-[var(--ui-accent)] hover:border-[var(--ui-accent)]"
            >
              {theme === 'dark' ? <Sun size={11} strokeWidth={1.75} /> : <Moon size={11} strokeWidth={1.75} />}
            </button>
            <AccountMenu compact />
          </div>
        </div>

        {/* Deliberately its own block, not nested inside the header's div
            above (that header ends at its own border-b) — per explicit
            instruction, this isn't "part of" the header. */}
        <div className="mb-[22px] shrink-0">
          <button
            type="button"
            onClick={() => router.push('/staff/tickets')}
            className="flex w-fit items-center gap-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            Back to queue
          </button>
        </div>

        {loadError && (
          <div className="mb-4 shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-700">{loadError}</div>
        )}

        {!ticket && !loadError && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin" strokeWidth={1.75} />
          </div>
        )}

        {ticket && (
          <div className="flex flex-1 gap-[18px] overflow-hidden">
            {/* Left: conversation — boxed container restored (previously
                removed to match a borderless mockup reference, then flagged
                as needed back: without a boundary the thread read as
                unbounded/"over-extended"). Same card treatment as the right
                panel (rounded-2xl/shadow-sm) for visual consistency between
                the two columns. */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#DDE0E7] bg-[#FFFFFF] dark:border-[#262B38] dark:bg-[#12151D]">
              {/* Leader name/subtitle/status live here, inside the chat
                  card — not in the standalone top header (that one is just
                  the "Tickets / TCK-X" breadcrumb + icons, no badge), per
                  explicit instruction that the status badge belongs in one
                  place only, next to the leader's name. */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-[18px] py-3">
                <div className="min-w-0">
                  <h1 className="truncate text-[12px] font-bold leading-tight text-foreground">{ticket.leaderName ?? 'Ticket'}</h1>
                  <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{`TCK-${ticket.id} · ${TITLE_LABEL[ticket.title]}`}</p>
                </div>
                {statusMeta && (
                  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] font-medium ${statusMeta.badgeClassName}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClassName}`} aria-hidden />
                    {statusMeta.label}
                  </span>
                )}
              </div>
              <div ref={threadContainerRef} onScroll={handleThreadScroll} onClick={markViewed} className="flex-1 space-y-[14px] overflow-y-auto p-[18px]">
                {messages.length === 0 && <p className="py-6 text-center text-[12px] text-muted-foreground">No messages yet. Send one below.</p>}
                {messages.map((m) => {
                  if (m.senderRole === 'system') {
                    return (
                      <div key={m.id} className="flex justify-center">
                        <p className="rounded-lg border border-dashed border-[#DDE0E7] px-3 py-1.5 text-center text-[10px] font-semibold text-muted-foreground dark:border-[#262B38]">
                          {m.message} · {formatDateTime(m.createdAt)}
                        </p>
                      </div>
                    );
                  }
                  const isStaffMsg = m.senderRole === 'staff';
                  const name = m.senderName ?? (isStaffMsg ? 'Staff' : (ticket.leaderName ?? 'Leader'));
                  const receipt = m.id === lastStaffMessage?.id ? staffMessageReceipt : m.id === lastLeaderMessage?.id ? leaderMessageReceipt : null;
                  return (
                    <div key={m.id} className={`flex items-start gap-2 ${isStaffMsg ? 'flex-row-reverse' : ''}`}>
                      {/* Avatar only on the agent/leader side — this is the
                          staff view, so a staff member doesn't need their
                          own avatar repeated on every message they send.
                          Name label removed entirely (both sides): the
                          leader's name is already shown once, in the chat
                          card's own header, above the thread. */}
                      {!isStaffMsg && (
                        <span className="mt-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#F1F2F5] text-[8.5px] font-semibold text-foreground dark:bg-[#1A1E29]" aria-hidden>
                          {initials(name)}
                        </span>
                      )}
                      <div className={`flex max-w-[78%] flex-col ${isStaffMsg ? 'items-end' : 'items-start'}`}>
                        <div
                          className={`overflow-hidden rounded-xl text-[11.5px] ${m.message ? 'px-3 py-2' : 'p-1'} ${
                            isStaffMsg
                              ? 'bg-[#2E6BDB14] text-foreground dark:bg-[#4E8BF01A]'
                              : 'border border-[#DDE0E7] bg-[#F1F2F5] text-foreground dark:border-[#262B38] dark:bg-[#1A1E29]'
                          }`}
                        >
                          {m.attachmentData && (
                            // Plain <img>, not next/image — a base64 data: URL,
                            // not something its remote-optimizer can handle.
                            // Fixed box, not w-full — an image-only bubble has
                            // no defined width of its own, so an intrinsically
                            // sized <img> collapses toward the source image's
                            // actual pixel dimensions (confirmed live during
                            // the earlier prototype build).
                            <img
                              src={`data:${m.attachmentMimeType};base64,${m.attachmentData}`}
                              alt={m.attachmentName ?? 'Attached image'}
                              className={`h-40 w-56 max-w-full rounded-lg object-cover ${m.message ? 'mb-1.5' : ''}`}
                            />
                          )}
                          {m.message && <p className="whitespace-pre-wrap break-words">{m.message}</p>}
                        </div>
                        <span className="mt-1 text-[9px] text-muted-foreground">
                          {formatDateTime(m.createdAt)}
                          {receipt && <> · {receipt === 'seen' ? 'Seen' : 'Delivered'}</>}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div ref={threadEndRef} />
              </div>

              {sendError && (
                <div className="shrink-0 border-t border-border px-4 pt-2">
                  <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] font-medium text-rose-700">{sendError}</p>
                </div>
              )}

              <div className="shrink-0 border-t border-border p-3">
                {closed ? (
                  <p className="py-2 text-center text-[10px] font-medium text-muted-foreground">
                    {isRejected ? 'This ticket was rejected — conversation is closed.' : 'This ticket is settled — conversation is closed.'}
                  </p>
                ) : (
                  <>
                    {attachmentPreviewUrl && (
                      <div className="relative mb-2 inline-block h-14 w-14 overflow-hidden rounded-lg border border-border">
                        {/* eslint-disable-next-line @next/next/no-img-element -- local data: URL preview of the just-picked file */}
                        <img src={attachmentPreviewUrl} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => {
                            setAttachment(null);
                            setAttachmentPreviewUrl(null);
                          }}
                          aria-label="Remove attached image"
                          className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-rose-600 text-white"
                        >
                          <X size={10} strokeWidth={1.75} />
                        </button>
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChosen} />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        aria-label="Attach image"
                        className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/10"
                      >
                        <ImagePlus size={17} strokeWidth={1.75} />
                      </button>
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onFocus={markViewed}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                        placeholder="Reply to this leader"
                        rows={1}
                        className="min-h-[42px] flex-1 resize-none rounded-lg border border-[#DDE0E7] bg-[#F1F2F5] px-3 py-2.5 text-[10.5px] focus:border-foreground focus:outline-none dark:border-[#262B38] dark:bg-[#1A1E29]"
                      />
                      <button
                        type="button"
                        onClick={handleSend}
                        disabled={(!draft.trim() && !attachment) || sending}
                        aria-label="Send message"
                        className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg text-background ${
                          (draft.trim() || attachment) && !sending ? 'bg-foreground' : 'cursor-not-allowed bg-muted-foreground/40'
                        }`}
                      >
                        {sending ? <Loader2 size={16} className="animate-spin" strokeWidth={1.75} /> : <Send size={16} strokeWidth={1.75} />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right: info panel */}
            <div className="w-[320px] shrink-0 overflow-y-auto pr-0.5">
              <div className="mb-3 rounded-2xl border border-[#DDE0E7] bg-[#FFFFFF] px-4 py-[14px] dark:border-[#262B38] dark:bg-[#12151D]">
                <h3 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Ticket Details</h3>
                <div className="mb-3 flex items-center justify-between gap-2">
                  {(() => {
                    const tag = TAG_META[getTag(ticket)];
                    return (
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] font-medium ${tag.className}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${tag.dotClassName}`} aria-hidden />
                        {tag.label}
                      </span>
                    );
                  })()}
                </div>
                <p className="mb-3 text-[9.5px] text-muted-foreground">Submitted {formatDateTime(ticket.createdAt)}</p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-5 gap-y-4 border-t border-border/60 pt-3">
                  {ticket.title === 'agent_concern' && (
                    <>
                      <DetailBlock label="Issue type" value={ticket.issueType ?? '—'} />
                      <DetailBlock label="Agent ID(s)" value={ticket.agentCodes.join(', ') || '—'} />
                    </>
                  )}
                  {ticket.title === 'shop_replacement' && <DetailBlock label="Shop(s)" value={ticket.shopCodes.join(', ') || '—'} />}
                  {ticket.title === 'adding_new_account' && (
                    <>
                      <DetailBlock label="Daily limit" value={ticket.dailyLimit ?? '—'} />
                      <DetailBlock label="Limit duration" value={ticket.limitDuration ? DURATION_LABEL[ticket.limitDuration] : '—'} />
                      <DetailBlock label="Number of shops" value={ticket.numShops != null ? String(ticket.numShops) : '—'} />
                    </>
                  )}
                  {ticket.details && <DetailBlock label="Details" value={ticket.details} />}
                </div>
              </div>

              <div className="mb-3 rounded-2xl border border-[#DDE0E7] bg-[#FFFFFF] px-4 py-[14px] dark:border-[#262B38] dark:bg-[#12151D]">
                <h3 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Settle This Ticket</h3>
                {statusError && <p className="mb-2 text-[9.5px] font-medium text-rose-600">{statusError}</p>}
                {closed && (
                  <p
                    className={`mb-2 rounded-md border px-3 py-2.5 text-center text-[10px] font-semibold ${
                      isRejected ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {isRejected ? 'This ticket is rejected.' : 'This ticket is settled.'}
                  </p>
                )}
                {/* Kept visible (disabled) rather than removed once closed —
                    matches the reference's own locked state, which shows the
                    banner above a dimmed action set instead of swapping the
                    buttons out entirely. Still fully locked either way: the
                    disabled attribute blocks the click, and PATCH .../status
                    /POST .../messages both reject server-side regardless. */}
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={statusUpdating || closed}
                    onClick={() => setConfirmSettleOpen(true)}
                    className="rounded-lg bg-blue-600 px-[15px] py-[9px] text-center text-[11px] font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Resolve
                  </button>
                  {/* Sends the leader a real explanatory message (see
                      REJECT_MESSAGE in the API route) and closes the
                      ticket as a distinct terminal "Rejected" status — for
                      requests outside this system's scope, which should
                      instead go through the leader's Team Leader via
                      Telegram. */}
                  <button
                    type="button"
                    disabled={statusUpdating || closed}
                    onClick={() => setConfirmRejectOpen(true)}
                    className="rounded-lg bg-transparent px-[15px] py-[9px] text-center text-[11px] font-bold text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
                {/* Not persisted — the real ticket schema has no notes
                    column yet; adding one is a schema change out of this
                    pass's scope (see the redesign's final report). */}
                <div className="mt-3 border-t border-border pt-3">
                  <label className="mb-1.5 block text-[9.5px] font-semibold text-muted-foreground">Internal notes (visible to settlers only)</label>
                  <textarea
                    placeholder="Add context for the next person who touches this ticket…"
                    rows={3}
                    className="w-full resize-none rounded-lg border border-[#DDE0E7] bg-[#F1F2F5] px-2.5 py-2 text-[10.5px] focus:border-foreground focus:outline-none dark:border-[#262B38] dark:bg-[#1A1E29]"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-[#DDE0E7] bg-[#FFFFFF] px-4 py-[14px] dark:border-[#262B38] dark:bg-[#12151D]">
                <h3 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Status History</h3>
                <div className="space-y-4">
                  {deriveStatusHistory(ticket, messages).map((h, i) => (
                    <div key={i} className="flex gap-2.5">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" aria-hidden />
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold text-foreground">{h.label}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {formatDateTime(h.timestamp)} · {h.actor}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmSettleModal
        isOpen={confirmSettleOpen}
        onClose={() => setConfirmSettleOpen(false)}
        onConfirm={() => handleStatusChange('settled')}
      />
      <ConfirmRejectModal isOpen={confirmRejectOpen} onClose={() => setConfirmRejectOpen(false)} onConfirm={handleReject} />
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[11.5px] font-semibold text-foreground">{value}</p>
    </div>
  );
}

// The required 2nd-confirmation step before Settled actually applies (per
// explicit instruction — settling is terminal, see the file-level comment).
// Same overlay/card/esc lifecycle as ConfirmDeleteModal (modalTheme.ts) so
// it reads as the same design system, kept as a local, non-destructive
// variant (emerald glyph, not rose) rather than generalizing that shared
// component — this is the only non-destructive confirm dialog in the app
// so far, not worth an abstraction until a second caller needs one.
function ConfirmSettleModal({ isOpen, onClose, onConfirm }: { isOpen: boolean; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setConfirming(false);
      setError(null);
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => setRendered(false), 120);
      return () => clearTimeout(timer);
    }
  }, [isOpen, rendered]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const handleConfirmClick = async () => {
    try {
      setConfirming(true);
      setError(null);
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  return createPortal(
    <div className={MODAL_OVERLAY_CLASS(closing)} onClick={onClose}>
      <div role="alertdialog" aria-modal="true" aria-label="Mark ticket as settled" onClick={(event) => event.stopPropagation()} className={MODAL_CARD_CLASS(closing)}>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
            <AlertTriangle size={17} strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Mark this ticket as Settled?</h2>
            <p className="mt-1.5 text-[12px] text-muted-foreground">This closes the conversation and can&apos;t be undone — the ticket can&apos;t be reopened afterward.</p>
          </div>
        </div>

        {error && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400">
            <AlertTriangle size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            <span>{error}</span>
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
              onClick={handleConfirmClick}
              disabled={confirming}
              className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} bg-blue-600 shadow-[0_6px_16px_-4px_rgba(37,99,235,0.55)] hover:bg-blue-700`}
            >
              {confirming ? 'Resolving...' : 'Resolve'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Twin of ConfirmSettleModal (same overlay/card/esc lifecycle), rose-tinted
// instead of blue since Reject is the app's one reserved use of red/rose —
// see STATUS_META's own comment. Confirming actually sends the leader a
// real message (POST .../reject), not just a status flip, so this step
// matters more here than a typical "are you sure."
function ConfirmRejectModal({ isOpen, onClose, onConfirm }: { isOpen: boolean; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setConfirming(false);
      setError(null);
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => setRendered(false), 120);
      return () => clearTimeout(timer);
    }
  }, [isOpen, rendered]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, onClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const handleConfirmClick = async () => {
    try {
      setConfirming(true);
      setError(null);
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject this ticket. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  return createPortal(
    <div className={MODAL_OVERLAY_CLASS(closing)} onClick={onClose}>
      <div role="alertdialog" aria-modal="true" aria-label="Reject ticket" onClick={(event) => event.stopPropagation()} className={MODAL_CARD_CLASS(closing)}>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
            <AlertTriangle size={17} strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Reject this ticket?</h2>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              This sends the leader a message explaining the request is outside this system&apos;s scope, and closes the conversation. This can&apos;t be undone.
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400">
            <AlertTriangle size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            <span>{error}</span>
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
              onClick={handleConfirmClick}
              disabled={confirming}
              className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} bg-rose-600 shadow-[0_6px_16px_-4px_rgba(225,29,72,0.55)] hover:bg-rose-700`}
            >
              {confirming ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
