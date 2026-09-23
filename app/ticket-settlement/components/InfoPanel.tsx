'use client';

import { useState } from 'react';
import { getTag, LINE_LABEL, STATUS_META, TAG_META } from '../mockData';
import type { Ticket } from '../types';
import styles from '../settlement.module.css';

const DURATION_LABEL: Record<'day_shift' | '24_hours', string> = { day_shift: 'Day shift', '24_hours': '24 hours' };

function FieldsCard({ ticket }: { ticket: Ticket }) {
  const f = ticket.fields;
  return (
    <div className={styles.fieldGrid}>
      {f.type === 'agent_concern' && (
        <>
          <div className={styles.field}>
            <label>Issue type</label>
            <div className={styles.fieldVal}>{f.issueType}</div>
          </div>
          <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
            <label>Agent ID{f.agentIds.length > 1 ? 's' : ''}</label>
            <div className={styles.tagList}>
              {f.agentIds.map((id) => (
                <span key={id} className={styles.agentPill}>
                  {id}
                </span>
              ))}
            </div>
          </div>
          {f.details && <div className={styles.notesBlock}>{f.details}</div>}
        </>
      )}
      {f.type === 'shop_replacement' && (
        <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
          <label>Shop to replace</label>
          <div className={styles.fieldVal}>{f.shop}</div>
        </div>
      )}
      {f.type === 'adding_new_account' && (
        <>
          <div className={styles.field}>
            <label>Daily limit</label>
            <div className={styles.fieldVal}>{f.dailyLimit}</div>
          </div>
          <div className={styles.field}>
            <label>Limit duration</label>
            <div className={styles.fieldVal}>{DURATION_LABEL[f.limitDuration]}</div>
          </div>
          <div className={styles.field}>
            <label>Number of shops</label>
            <div className={styles.fieldVal}>{f.numShops}</div>
          </div>
        </>
      )}
    </div>
  );
}

export default function InfoPanel({
  ticket,
  onResolve,
  onReject,
  onRequestInfo,
  onNotesChange,
}: {
  ticket: Ticket;
  onResolve: () => void;
  onReject: (reason: string) => void;
  onRequestInfo: (comment: string) => void;
  onNotesChange: (notes: string) => void;
}) {
  const [activeForm, setActiveForm] = useState<'reject' | 'info' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [comment, setComment] = useState('');

  const closed = ticket.status === 'resolved' || ticket.status === 'rejected';

  function resetForms() {
    setActiveForm(null);
    setReason('');
    setReasonMissing(false);
    setComment('');
  }

  function submitReject() {
    if (!reason.trim()) {
      setReasonMissing(true);
      return;
    }
    onReject(reason.trim());
    resetForms();
  }

  function submitRequestInfo() {
    onRequestInfo(comment.trim());
    resetForms();
  }

  return (
    <div className={styles.infoCol}>
      <div className={styles.card}>
        <h3>TICKET DETAILS</h3>
        <div className={styles.detailMetaRow}>
          <span className={`${styles.tagChip} ${styles[TAG_META[getTag(ticket)].cls]}`}>{TAG_META[getTag(ticket)].label}</span>
          <span>{LINE_LABEL[ticket.line]}</span>
          <span>Submitted {ticket.submittedAt}</span>
        </div>
        <FieldsCard ticket={ticket} />
      </div>

      <div className={styles.card}>
        <h3>SETTLE THIS TICKET</h3>
        {ticket.status === 'resolved' && <div className={`${styles.resolvedBanner} ${styles.bannerOk}`}>This ticket is resolved.</div>}
        {ticket.status === 'rejected' && <div className={`${styles.resolvedBanner} ${styles.bannerNo}`}>This ticket was rejected.</div>}
        <div className={styles.actionStack}>
          <button type="button" className={`${styles.btn} ${styles.btnFull} ${styles.btnPrimary}`} disabled={closed} onClick={onResolve}>
            Approve &amp; resolve
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnFull} ${styles.btnDanger}`}
            disabled={closed}
            onClick={() => setActiveForm(activeForm === 'reject' ? null : 'reject')}
          >
            Reject
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnFull} ${styles.btnGhost}`} disabled={closed} onClick={() => setActiveForm(activeForm === 'info' ? null : 'info')}>
            Request more info
          </button>
        </div>

        {activeForm === 'reject' && (
          <div className={styles.inlineForm}>
            <label>
              Reason for rejection <span className={styles.reqMark}>*</span>
            </label>
            <textarea
              className={`${styles.textarea} ${reasonMissing ? styles.textareaError : ''}`}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonMissing) setReasonMissing(false);
              }}
              placeholder="Explain what's missing or wrong so the leader can fix and resubmit…"
            />
            <div className={styles.formActions}>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={submitReject}>
                Confirm rejection
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={resetForms}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {activeForm === 'info' && (
          <div className={styles.inlineForm}>
            <label>What do you need from the leader?</label>
            <textarea className={styles.textarea} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Please attach the trade license photo." />
            <div className={styles.formActions}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={submitRequestInfo}>
                Send request
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={resetForms}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className={styles.inlineForm}>
          <label>Internal notes (visible to settlers only)</label>
          <textarea
            className={styles.textarea}
            defaultValue={ticket.internalNotes}
            onBlur={(e) => onNotesChange(e.target.value)}
            placeholder="Add context for the next person who touches this ticket…"
          />
        </div>
      </div>

      <div className={styles.card}>
        <h3>STATUS HISTORY</h3>
        <div className={styles.timeline}>
          {ticket.history.map((h, i) => (
            <div key={i} className={styles.tlItem}>
              <div className={styles.tlStatus}>{STATUS_META[h.status].label}</div>
              <div className={styles.tlMeta}>
                {h.timestamp} · {h.actor}
              </div>
              {h.note && <div className={styles.tlNote}>{h.note}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
