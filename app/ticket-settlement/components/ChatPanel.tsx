'use client';

import { useEffect, useRef, useState } from 'react';
import { Paperclip, Send } from 'lucide-react';
import { STATUS_META, TYPE_META } from '../mockData';
import type { Ticket } from '../types';
import styles from '../settlement.module.css';

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function ChatPanel({ ticket, onSendMessage }: { ticket: Ticket; onSendMessage: (text: string, imageDataUrl?: string) => void }) {
  const [draft, setDraft] = useState('');
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const closed = ticket.status === 'resolved' || ticket.status === 'rejected';

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ticket.messages, ticket.id]);

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleSend() {
    const text = draft.trim();
    if (!text && !pendingImage) return;
    onSendMessage(text, pendingImage ?? undefined);
    setDraft('');
    setPendingImage(null);
  }

  return (
    <div className={styles.chatCol}>
      <div className={styles.chatHead}>
        <div>
          <div className={styles.chatHeadId}>{ticket.leaderName}</div>
          <div className={styles.chatHeadSub}>
            {ticket.id} · {TYPE_META[ticket.fields.type].label}
          </div>
        </div>
        <span className={`${styles.chip} ${styles[STATUS_META[ticket.status].cls]}`}>{STATUS_META[ticket.status].label}</span>
      </div>

      <div className={styles.chatMessages} ref={messagesRef}>
        {ticket.messages.map((m) => {
          if (m.from === 'system') {
            return (
              <div key={m.id} className={`${styles.msgRow} ${styles.systemRow}`}>
                <div className={`${styles.msgBubble} ${styles.msgBubbleSystem}`}>{m.text}</div>
              </div>
            );
          }
          const isSettler = m.from === 'settler';
          return (
            <div key={m.id} className={`${styles.msgRow} ${isSettler ? styles.msgRowSettler : ''}`}>
              <div className={styles.msgAvatar}>{initialsOf(m.author ?? '')}</div>
              <div className={styles.msgBody}>
                <div className={styles.msgName}>{m.author}</div>
                <div className={styles.msgBubble}>
                  {m.imageDataUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- a local data: URL, not something next/image's remote optimizer can handle
                    <img src={m.imageDataUrl} alt="" className={styles.msgImage} onClick={() => window.open(m.imageDataUrl)} />
                  )}
                  {m.text && <div className={m.imageDataUrl ? styles.msgImageCaption : undefined}>{m.text}</div>}
                </div>
                <div className={styles.msgTime}>{m.timestamp}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.composer}>
        {closed ? (
          <div className={styles.composerDisabled}>This ticket is {STATUS_META[ticket.status].label.toLowerCase()} — conversation is closed.</div>
        ) : (
          <>
            {pendingImage && (
              <div className={styles.attachChip}>
                {/* eslint-disable-next-line @next/next/no-img-element -- local data: URL preview of the just-picked file */}
                <img src={pendingImage} alt="" />
                <button type="button" className={styles.attachChipRemove} onClick={() => setPendingImage(null)} aria-label="Remove attached image">
                  ×
                </button>
              </div>
            )}
            <div className={styles.composerRow}>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChosen} />
              <button type="button" className={styles.iconBtn} title="Attach image" aria-label="Attach image" onClick={() => fileInputRef.current?.click()}>
                <Paperclip size={17} />
              </button>
              <textarea
                className={styles.composerInput}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message ${ticket.leaderName}…`}
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button type="button" className={styles.sendBtn} title="Send" aria-label="Send message" disabled={!draft.trim() && !pendingImage} onClick={handleSend}>
                <Send size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
