'use client';

// Ticket detail + messenger-style chat thread. Same standalone flow as
// /tickets and /tickets/create (bypasses AppShell/Sidebar — see
// AppShell.tsx's pathname bypass), now on the dashboard's shared design
// tokens (app/globals.css) instead of a hardcoded palette, so dark mode
// and the --product-accent color both apply automatically.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Camera,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  Paperclip,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import { useVisibilityPolling } from '@/app/lib/useVisibilityPolling';

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
  // Read-receipt source — see receiptFor() below. Both are visible to both
  // roles (unlike the assignee-name redaction elsewhere): each side needs
  // the OTHER side's viewed-at to compute its own "Seen"/"Delivered".
  lastViewedAt: string | null;
  staffLastViewedAt: string | null;
};

type Message = {
  id: number;
  senderId: number;
  // 'system' is an auto-generated log entry (e.g. a staff status change) —
  // rendered as a centered note, not a chat bubble, and never grouped.
  senderRole: 'leader' | 'staff' | 'system';
  message: string;
  // Image-only attachment (Photo/Camera) — stored inline as base64, see
  // POST /api/tickets/:id/messages. Null for plain text messages and for
  // Document picks (not persisted, no viewer built for those yet).
  attachmentData: string | null;
  attachmentMimeType: string | null;
  attachmentName: string | null;
  createdAt: string;
};

// A picked-but-not-yet-sent file — front-end only (see the note above
// handleSend and the backend-gaps list in the redesign's final report):
// there's no attachment column/table or upload endpoint yet, so this can't
// actually be persisted onto the message. The picker/preview interaction
// itself is real (a genuine File from the browser's file input, not a
// placeholder string) — `file` is kept so the composer chip can render an
// actual image thumbnail (via a local object URL), not just the filename.
type PendingAttachment = { name: string; kind: 'photo' | 'camera' | 'document'; file: File };

const TITLE_LABEL: Record<TicketDetail['title'], string> = {
  agent_concern: 'Agent concern',
  shop_replacement: 'Shop replacement',
  adding_new_account: 'Adding new account',
};

const DURATION_LABEL: Record<string, string> = { day_shift: 'Day shift', '24_hours': '24 hours' };

// Same amber/blue/emerald convention the staff queue and the leader list
// page already use — reused, not reinvented.
const STATUS_STYLE: Record<TicketDetail['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  ongoing: { label: 'Ongoing', className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' },
  settled: { label: 'Settled', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' },
};

const POLL_INTERVAL_MS = 4500;
// How close to the bottom (px) still counts as "was reading the latest" —
// a new message auto-scrolls only if the reader was already about there,
// so someone scrolled up into history never gets yanked back down.
const NEAR_BOTTOM_THRESHOLD_PX = 120;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "Today" / "Yesterday" / "Sep 4" — the date-divider label between groups
// of messages sent on different calendar days.
function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Collapsed-state one-liner — the key fields for this ticket type plus
// when it was submitted, joined into a single row.
function condensedSummary(t: TicketDetail): string {
  const parts: string[] = [];
  if (t.title === 'agent_concern') {
    parts.push(t.issueType ?? 'Issue');
    if (t.agentCodes.length) parts.push(t.agentCodes.join(', '));
  } else if (t.title === 'shop_replacement') {
    if (t.shopCodes.length) parts.push(t.shopCodes.join(', '));
  } else {
    parts.push(`${t.numShops ?? '?'} shop${t.numShops === 1 ? '' : 's'}`);
    if (t.dailyLimit) parts.push(`Limit ${t.dailyLimit}`);
  }
  parts.push(`Submitted ${formatDateTime(t.createdAt)}`);
  return parts.join(' · ');
}

// Last message per sender (system messages never carry a receipt) — same
// computation both roles see, since lastViewedAt/staffLastViewedAt are
// both visible to both sides.
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

type ThreadItem =
  | { kind: 'divider'; id: string; label: string }
  | { kind: 'system'; id: string; message: Message }
  | { kind: 'group'; id: string; senderRole: 'leader' | 'staff'; messages: Message[] };

// Groups consecutive same-sender messages (messenger-style: one timestamp
// per group instead of per bubble) and inserts a date divider whenever the
// calendar day changes. A day change or a system message always breaks the
// current group — the next real message starts a fresh one.
function buildThreadItems(messages: Message[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let lastDateKey: string | null = null;
  let currentGroup: Message[] | null = null;
  let currentGroupRole: 'leader' | 'staff' | null = null;

  for (const m of messages) {
    const dateKey = new Date(m.createdAt).toDateString();
    if (dateKey !== lastDateKey) {
      currentGroup = null;
      currentGroupRole = null;
      items.push({ kind: 'divider', id: `divider-${dateKey}`, label: formatDayLabel(m.createdAt) });
      lastDateKey = dateKey;
    }
    if (m.senderRole === 'system') {
      currentGroup = null;
      currentGroupRole = null;
      items.push({ kind: 'system', id: `sys-${m.id}`, message: m });
      continue;
    }
    if (currentGroupRole === m.senderRole && currentGroup) {
      currentGroup.push(m);
    } else {
      currentGroup = [m];
      currentGroupRole = m.senderRole;
      items.push({ kind: 'group', id: `group-${m.id}`, senderRole: m.senderRole, messages: currentGroup });
    }
  }
  return items;
}

export default function TicketDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const threadContainerRef = useRef<HTMLDivElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Updated on every scroll (not measured post-render), so the effect
  // below knows whether the reader was already near the bottom BEFORE a
  // poll appended anything — measuring after the fact would always read
  // "near bottom" once new content has already grown scrollHeight.
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
          // Bail out to the same reference when nothing changed, so
          // dependents (none currently, but keeps this cheap either way)
          // don't re-run needlessly on identical poll responses.
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
          return next;
        });
        setMessages((prev) => {
          const next = (data.messages ?? []) as Message[];
          if (prev.length === next.length && prev.every((m, i) => m.id === next[i]?.id)) return prev;
          return next;
        });
      })
      .catch(() => {
        setLoadError('Could not load this ticket. Try refreshing the page.');
      });
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

  // Closes the overflow menu / attach picker on an outside click — each
  // wraps its own toggle button + panel, so a click on the toggle itself
  // still reaches the button's own onClick right after this closes it.
  useEffect(() => {
    if (!menuOpen && !attachMenuOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (menuOpen && overflowWrapRef.current && !overflowWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (attachMenuOpen && attachWrapRef.current && !attachWrapRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [menuOpen, attachMenuOpen]);

  function handleThreadScroll() {
    const el = threadContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
  }

  // Explicit "I actually looked at this" signal — fired only on focusing
  // the reply textbox or clicking the thread itself, never from a poll
  // tick or page load, so having the tab open doesn't silently mark
  // things "Seen." Best-effort: a failed write here just means the other
  // side sees "Delivered" a beat longer, not worth surfacing an error for.
  function markViewed() {
    fetch(`/api/tickets/${params.id}/view`, { method: 'POST' }).catch(() => {});
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>, kind: PendingAttachment['kind']) {
    const file = e.target.files?.[0];
    if (file) setAttachment({ name: file.name, kind, file });
    e.target.value = '';
    setAttachMenuOpen(false);
  }

  // Real thumbnail for the composer chip — a local object URL pointing at
  // the actual picked file's bytes, not a placeholder icon. Only makes
  // sense for photo/camera; documents keep the file icon.
  const attachmentPreviewUrl = useMemo(() => {
    if (!attachment || attachment.kind === 'document' || !attachment.file.type.startsWith('image/')) return null;
    return URL.createObjectURL(attachment.file);
  }, [attachment]);

  // Revokes the previous object URL whenever it changes or the composer
  // unmounts, so picking several images in a row doesn't leak them.
  useEffect(() => {
    return () => {
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    };
  }, [attachmentPreviewUrl]);

  // Strips the "data:image/png;base64," prefix FileReader's own data URL
  // includes — the API stores/returns the raw base64 payload plus a
  // separate mime-type field, not a ready-made data URL.
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
    const isImageAttachment = attachment && attachment.kind !== 'document' && attachment.file.type.startsWith('image/');
    if ((!text && !isImageAttachment) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const body: Record<string, unknown> = { message: text };
      if (isImageAttachment && attachment) {
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
      setMessages((prev) => [...prev, data.message]);
      setDraft('');
      // No attachment backend yet (see the redesign's backend-gaps note) —
      // a staged file can't travel with the message, so it's cleared here
      // rather than silently left attached to nothing.
      setAttachment(null);
      setSending(false);
    } catch {
      setSendError('Could not send your message.');
      setSending(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 font-[Inter,sans-serif]">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-[15px] font-bold text-foreground">Ticket not found</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">This ticket doesn&apos;t exist or isn&apos;t yours to view.</p>
          <button
            type="button"
            onClick={() => router.push('/tickets')}
            className="mt-6 rounded-[10px] bg-[color:var(--ui-accent)] px-4 py-2.5 text-[13px] font-bold text-white"
          >
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
  const threadItems = buildThreadItems(messages);

  return (
    // h-screen + overflow-hidden (not min-h-screen): the thread below is
    // the only region that scrolls, so a short thread never leaves a gray
    // gap between the last message and the reply bar — the reply bar sits
    // at the true bottom of a fixed-height column instead of relying on
    // `sticky` inside a shorter-than-viewport page.
    <div className="flex h-screen w-full justify-center overflow-hidden bg-background font-[Inter,sans-serif] text-foreground">
      <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={() => router.push('/tickets')} aria-label="Back to tickets" className="shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]">
              <ArrowLeft size={18} />
            </button>
            <span className="truncate text-[15px] font-bold">{ticket ? TITLE_LABEL[ticket.title] : 'Ticket'}</span>
            {ticket && (
              <span className={`inline-flex shrink-0 items-center rounded-[6px] px-2 py-0.5 text-[10.5px] font-bold ${STATUS_STYLE[ticket.status].className}`}>
                {STATUS_STYLE[ticket.status].label}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div ref={overflowWrapRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="More options"
                aria-expanded={menuOpen}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-border text-muted-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
              >
                <MoreVertical size={16} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-10 mt-1.5 w-40 rounded-xl border border-border bg-card p-1.5 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      loadTicket();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                  >
                    <RefreshCw size={14} />
                    Refresh
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {loadError && (
          <div className="m-4 shrink-0 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
            {loadError}
          </div>
        )}

        {!ticket && !loadError && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {ticket && (
          <>
            <div className="shrink-0 px-4 pt-3">
              <button
                type="button"
                onClick={() => setSummaryExpanded((v) => !v)}
                aria-expanded={summaryExpanded}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{condensedSummary(ticket)}</span>
                <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform ${summaryExpanded ? 'rotate-180' : ''}`} />
              </button>
              {summaryExpanded && (
                <div className="mt-2 rounded-xl border border-border bg-card px-3.5 py-1 text-[12.5px]">
                  {ticket.title === 'agent_concern' && (
                    <>
                      <DetailRow label="Issue type" value={ticket.issueType ?? '—'} />
                      <DetailRow label="Agent ID(s)" value={ticket.agentCodes.join(', ') || '—'} />
                    </>
                  )}
                  {ticket.title === 'shop_replacement' && <DetailRow label="Shop(s)" value={ticket.shopCodes.join(', ') || '—'} />}
                  {ticket.title === 'adding_new_account' && (
                    <>
                      <DetailRow label="Daily limit" value={ticket.dailyLimit ?? '—'} />
                      <DetailRow label="Limit duration" value={ticket.limitDuration ? DURATION_LABEL[ticket.limitDuration] : '—'} />
                      <DetailRow label="Number of shops" value={ticket.numShops != null ? String(ticket.numShops) : '—'} />
                    </>
                  )}
                  {ticket.details && <DetailRow label="Details" value={ticket.details} />}
                  <DetailRow label="Submitted" value={formatDateTime(ticket.createdAt)} last />
                </div>
              )}
            </div>

            <div ref={threadContainerRef} onScroll={handleThreadScroll} onClick={markViewed} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 && <p className="py-6 text-center text-[12px] text-muted-foreground">No messages yet. Send one below.</p>}
              {threadItems.map((item) => {
                if (item.kind === 'divider') {
                  return (
                    <div key={item.id} className="flex items-center justify-center py-1">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">{item.label}</span>
                    </div>
                  );
                }
                if (item.kind === 'system') {
                  return (
                    <p key={item.id} className="py-1 text-center text-[11px] text-muted-foreground">
                      {item.message.message} · {formatTime(item.message.createdAt)}
                    </p>
                  );
                }
                const isLeader = item.senderRole === 'leader';
                const lastInGroup = item.messages[item.messages.length - 1];
                const receipt = lastInGroup.id === lastStaffMessage?.id ? staffMessageReceipt : lastInGroup.id === lastLeaderMessage?.id ? leaderMessageReceipt : null;
                return (
                  <div key={item.id} className={`flex flex-col ${isLeader ? 'items-end' : 'items-start'}`}>
                    {!isLeader && (
                      <div className="mb-1 flex items-center gap-1.5 pl-0.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground">OP</span>
                        <span className="text-[11px] font-semibold text-muted-foreground">Ops</span>
                      </div>
                    )}
                    <div className="flex max-w-[75%] flex-col gap-0.5">
                      {item.messages.map((m) => (
                        <div
                          key={m.id}
                          className={`overflow-hidden rounded-xl text-[13px] ${m.message ? 'px-3 py-2' : 'p-1'} ${
                            isLeader ? 'bg-[color:var(--ui-accent)] text-white' : 'border border-border bg-card text-foreground'
                          }`}
                        >
                          {m.attachmentData && (
                            // Real sent image (base64 stored on the message
                            // row, see POST /api/tickets/:id/messages) — not
                            // next/image, since a data: URL isn't something
                            // its remote-optimizer pipeline can handle. Fixed
                            // box (not w-full) — the bubble has no defined
                            // width of its own for an image-only message, so
                            // a purely intrinsic-sized img would collapse
                            // toward whatever the original image's actual
                            // pixel dimensions happen to be (confirmed live:
                            // shrank to near-invisible for a small source
                            // image) instead of a sane, consistent thumbnail.
                            <img
                              src={`data:${m.attachmentMimeType};base64,${m.attachmentData}`}
                              alt={m.attachmentName ?? 'Attached image'}
                              className={`h-40 w-56 max-w-full rounded-lg object-cover ${m.message ? 'mb-1.5' : ''}`}
                            />
                          )}
                          {m.message && <p className="whitespace-pre-wrap break-words">{m.message}</p>}
                        </div>
                      ))}
                    </div>
                    <p className={`mt-1 text-[10.5px] ${isLeader ? 'text-muted-foreground' : 'text-muted-foreground'}`}>{formatTime(lastInGroup.createdAt)}</p>
                    {receipt && (
                      <span className={`px-1 text-[10px] ${receipt === 'seen' ? 'text-[color:var(--ui-accent)]' : 'text-muted-foreground'}`}>
                        {receipt === 'seen' ? 'Seen' : 'Delivered'}
                      </span>
                    )}
                  </div>
                );
              })}
              <div ref={threadEndRef} />
            </div>

            {sendError && (
              <div className="mx-4 mb-2 shrink-0 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
                {sendError}
              </div>
            )}

            <div className="shrink-0 border-t border-border bg-card px-4 py-3">
              {attachment && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] text-foreground">
                  {attachmentPreviewUrl ? (
                    // Plain <img>, not next/image — it's a local blob: object
                    // URL (the picked file's own bytes), which next/image's
                    // remote-optimizer pipeline can't handle.
                    <img src={attachmentPreviewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  ) : attachment.kind === 'document' ? (
                    <FileText size={14} className="shrink-0" />
                  ) : (
                    <ImageIcon size={14} className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachment(null)}
                    aria-label="Remove attachment"
                    className="shrink-0 rounded text-muted-foreground hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] dark:hover:text-rose-400"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <div ref={attachWrapRef} className="relative shrink-0">
                  <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileChosen(e, 'photo')} />
                  <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleFileChosen(e, 'camera')} />
                  <input
                    ref={documentInputRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                    className="hidden"
                    onChange={(e) => handleFileChosen(e, 'document')}
                  />
                  <button
                    type="button"
                    onClick={() => setAttachMenuOpen((v) => !v)}
                    aria-label="Attach file"
                    aria-expanded={attachMenuOpen}
                    className="flex h-[42px] w-[42px] items-center justify-center rounded-[10px] border border-border text-muted-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
                  >
                    <Paperclip size={18} />
                  </button>
                  {attachMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-border bg-card p-1.5 shadow-lg">
                      <button
                        type="button"
                        onClick={() => photoInputRef.current?.click()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        <ImageIcon size={15} />
                        Photo
                      </button>
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        <Camera size={15} />
                        Camera
                      </button>
                      <button
                        type="button"
                        onClick={() => documentInputRef.current?.click()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        <FileText size={15} />
                        Document
                      </button>
                    </div>
                  )}
                </div>
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
                  placeholder="Write a message"
                  rows={1}
                  className="min-h-[42px] flex-1 resize-none rounded-[10px] border border-border bg-background px-3 py-2.5 text-[13.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={(!draft.trim() && !attachment) || sending}
                  aria-label="Send message"
                  className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] focus-visible:ring-offset-2 ${
                    (draft.trim() || attachment) && !sending ? 'bg-[color:var(--ui-accent)]' : 'cursor-not-allowed bg-muted-foreground/40'
                  }`}
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-1.5 ${last ? '' : 'border-b border-border/60'}`}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
