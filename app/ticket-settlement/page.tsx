'use client';

// Ticket-settlement prototype — a settler-facing queue + resolution UI for
// leader-raised tickets. Mock data only (see mockData.ts): no DB table, no
// migration, no API route. Reuses the real ticket schema's type/field
// naming (app/lib/db/schema.ts, app/tickets/create/page.tsx) for
// consistency, but the four-state settle workflow here (submitted/review/
// resolved/rejected, reject reasons, request-info) is a new concept scoped
// only to this prototype — the real tickets table has no equivalent yet.
//
// Deliberately its own self-contained visual module (own Manrope/Space
// Grotesk fonts, own dark-default theme + localStorage key, own sidebar) —
// built to pixel-match an external design spec, not the dashboard's
// Inter/Design System v2 tokens. Bypasses AppShell entirely (see that
// file's own comment) so it isn't double-chromed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Manrope, Space_Grotesk } from 'next/font/google';
import { Moon, Sun } from 'lucide-react';
import Sidebar from './components/Sidebar';
import QueueView from './components/QueueView';
import DetailView from './components/DetailView';
import { buildInitialTickets } from './mockData';
import type { ChatMessage, Ticket } from './types';
import styles from './settlement.module.css';

const manrope = Manrope({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-manrope' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-space-grotesk' });

const THEME_KEY = 'settle_theme';
const SIDEBAR_KEY = 'settle_sidebar_collapsed';

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let msgSeq = 0;
function newMessageId(): string {
  msgSeq += 1;
  return `m${Date.now()}-${msgSeq}`;
}

export default function TicketSettlementPage() {
  const [tickets, setTickets] = useState<Ticket[]>(() => buildInitialTickets());
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Own theme/sidebar persistence, deliberately separate from the real
  // dashboard's ThemeProvider (this route never mounts inside it — see
  // AppShell's bypass) — dark-by-default unless previously toggled here.
  // One-time sync from a browser-only API on mount (can't read
  // localStorage in a lazy useState initializer without crashing SSR,
  // since `window` doesn't exist server-side) — the legitimate exception
  // react-hooks/set-state-in-effect's own message allows for ("subscribe
  // for updates from some external system").
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_KEY);
    if (savedTheme === 'dark' || savedTheme === 'light') setTheme(savedTheme);
    const savedCollapsed = window.localStorage.getItem(SIDEBAR_KEY);
    if (savedCollapsed === '1') setSidebarCollapsed(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Guards the two save-effects below against firing on the very first
  // mount — without this, the save-effect's first run (queued in the same
  // commit as the load-effect above, before that effect's setState has
  // applied) writes back the still-default value and clobbers whatever
  // was actually saved from a previous session (confirmed live: toggling
  // to light, reloading, and finding it silently reverted to dark).
  const skipThemeSave = useRef(true);
  const skipSidebarSave = useRef(true);

  useEffect(() => {
    if (skipThemeSave.current) {
      skipThemeSave.current = false;
      return;
    }
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (skipSidebarSave.current) {
      skipSidebarSave.current = false;
      return;
    }
    window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const activeTicket = useMemo(() => tickets.find((t) => t.id === activeTicketId) ?? null, [tickets, activeTicketId]);
  const queueCount = useMemo(() => tickets.filter((t) => t.status === 'submitted' || t.status === 'review').length, [tickets]);

  const updateTicket = useCallback((id: string, updater: (t: Ticket) => Ticket) => {
    setTickets((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  }, []);

  const handleSendMessage = useCallback(
    (text: string, imageDataUrl?: string) => {
      if (!activeTicketId) return;
      const message: ChatMessage = { id: newMessageId(), from: 'settler', author: 'Deepa Rahman', text, imageDataUrl, timestamp: nowStamp() };
      updateTicket(activeTicketId, (t) => ({ ...t, messages: [...t.messages, message] }));
    },
    [activeTicketId, updateTicket]
  );

  const handleResolve = useCallback(() => {
    if (!activeTicketId) return;
    const ts = nowStamp();
    updateTicket(activeTicketId, (t) => ({
      ...t,
      status: 'resolved',
      history: [...t.history, { status: 'resolved', timestamp: ts, actor: 'Deepa Rahman (settler)', note: t.internalNotes || undefined }],
      messages: [...t.messages, { id: newMessageId(), from: 'system', text: 'Deepa Rahman marked this ticket as resolved.', timestamp: ts }],
    }));
  }, [activeTicketId, updateTicket]);

  const handleReject = useCallback(
    (reason: string) => {
      if (!activeTicketId) return;
      const ts = nowStamp();
      updateTicket(activeTicketId, (t) => ({
        ...t,
        status: 'rejected',
        history: [...t.history, { status: 'rejected', timestamp: ts, actor: 'Deepa Rahman (settler)', note: reason }],
        messages: [
          ...t.messages,
          { id: newMessageId(), from: 'settler', author: 'Deepa Rahman', text: reason, timestamp: ts },
          { id: newMessageId(), from: 'system', text: 'Ticket rejected.', timestamp: ts },
        ],
      }));
    },
    [activeTicketId, updateTicket]
  );

  const handleRequestInfo = useCallback(
    (comment: string) => {
      if (!activeTicketId) return;
      const ts = nowStamp();
      const note = comment || 'Requested more information from the leader.';
      updateTicket(activeTicketId, (t) => ({
        ...t,
        status: 'review',
        history: [...t.history, { status: 'review', timestamp: ts, actor: 'Deepa Rahman (settler)', note }],
        messages: [...t.messages, { id: newMessageId(), from: 'settler', author: 'Deepa Rahman', text: note, timestamp: ts }],
      }));
    },
    [activeTicketId, updateTicket]
  );

  const handleNotesChange = useCallback(
    (notes: string) => {
      if (!activeTicketId) return;
      updateTicket(activeTicketId, (t) => ({ ...t, internalNotes: notes }));
    },
    [activeTicketId, updateTicket]
  );

  return (
    <div className={`${manrope.variable} ${spaceGrotesk.variable} ${styles.root}`} data-theme={theme}>
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)} queueCount={queueCount} />
      <div className={styles.main}>
        <div className={styles.topbar}>
          <div className={styles.crumb}>
            Settlement / <b>{activeTicket ? activeTicket.id : 'Live Queue'}</b>
          </div>
          <div className={styles.topbarRight}>
            <button
              type="button"
              className={styles.themeToggle}
              title="Toggle theme"
              aria-label="Toggle theme"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className={styles.avatar}>DR</div>
          </div>
        </div>
        <div className={styles.content}>
          {activeTicket ? (
            <DetailView
              ticket={activeTicket}
              onBack={() => setActiveTicketId(null)}
              onSendMessage={handleSendMessage}
              onResolve={handleResolve}
              onReject={handleReject}
              onRequestInfo={handleRequestInfo}
              onNotesChange={handleNotesChange}
            />
          ) : (
            <QueueView tickets={tickets} onOpenTicket={setActiveTicketId} />
          )}
        </div>
      </div>
    </div>
  );
}
