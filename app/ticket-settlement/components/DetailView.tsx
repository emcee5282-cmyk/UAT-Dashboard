'use client';

import { ChevronLeft } from 'lucide-react';
import ChatPanel from './ChatPanel';
import InfoPanel from './InfoPanel';
import type { Ticket } from '../types';
import styles from '../settlement.module.css';

export default function DetailView({
  ticket,
  onBack,
  onSendMessage,
  onResolve,
  onReject,
  onRequestInfo,
  onNotesChange,
}: {
  ticket: Ticket;
  onBack: () => void;
  onSendMessage: (text: string, imageDataUrl?: string) => void;
  onResolve: () => void;
  onReject: (reason: string) => void;
  onRequestInfo: (comment: string) => void;
  onNotesChange: (notes: string) => void;
}) {
  return (
    <div>
      <button type="button" className={styles.backLink} onClick={onBack}>
        <ChevronLeft size={13} strokeWidth={2.5} />
        Back to queue
      </button>

      <div className={styles.detailGrid}>
        {/* key={ticket.id}: remounts on ticket switch so the composer's
            local draft/pending-image state resets automatically — React's
            own recommended alternative to an effect for this. */}
        <ChatPanel key={ticket.id} ticket={ticket} onSendMessage={onSendMessage} />
        <InfoPanel ticket={ticket} onResolve={onResolve} onReject={onReject} onRequestInfo={onRequestInfo} onNotesChange={onNotesChange} />
      </div>
    </div>
  );
}
