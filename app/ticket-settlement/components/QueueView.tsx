'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { getTag, STATUS_META, TAG_META, TYPE_META } from '../mockData';
import type { Ticket, TicketType } from '../types';
import styles from '../settlement.module.css';

type TypeFilter = 'all' | TicketType;
type StatusFilter = 'all' | Ticket['status'];
type TagFilter = 'all' | 'OPS' | 'ACC';

function searchHaystack(t: Ticket): string {
  const fieldsText =
    t.fields.type === 'agent_concern'
      ? `${t.fields.issueType} ${t.fields.agentIds.join(' ')}`
      : t.fields.type === 'shop_replacement'
        ? t.fields.shop
        : `${t.fields.dailyLimit} ${t.fields.numShops}`;
  return `${t.id} ${t.leaderName} ${fieldsText}`.toLowerCase();
}

export default function QueueView({ tickets, onOpenTicket }: { tickets: Ticket[]; onOpenTicket: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState<TagFilter>('all');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets
      .filter((t) => {
        if (typeFilter !== 'all' && t.fields.type !== typeFilter) return false;
        if (statusFilter !== 'all' && t.status !== statusFilter) return false;
        if (tagFilter !== 'all' && getTag(t) !== tagFilter) return false;
        if (q && !searchHaystack(t).includes(q)) return false;
        return true;
      })
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  }, [tickets, search, typeFilter, statusFilter, tagFilter]);

  return (
    <div>
      <div className={styles.sectionLabel}>
        <span className={styles.pulseDot} />
        LIVE QUEUE
      </div>
      <h1 className={styles.pageTitle}>Tickets to settle</h1>

      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Search />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search leader, agent ID, shop, ticket ID…" />
        </div>
        <select className={styles.filterSelect} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}>
          <option value="all">All types</option>
          <option value="agent_concern">Agent concern</option>
          <option value="shop_replacement">Shop replacement</option>
          <option value="adding_new_account">Adding new account</option>
        </select>
        <select className={styles.filterSelect} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="review">In review</option>
          <option value="resolved">Resolved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select className={styles.filterSelect} value={tagFilter} onChange={(e) => setTagFilter(e.target.value as TagFilter)}>
          <option value="all">All tags</option>
          <option value="OPS">Operations Team</option>
          <option value="ACC">Account Team</option>
        </select>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Type</th>
              <th>Leader</th>
              <th>Tagging</th>
              <th>Submitted</th>
              <th>Priority</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className={styles.emptyRow}>
                <td colSpan={7}>No tickets match these filters.</td>
              </tr>
            )}
            {rows.map((t) => {
              const tm = TYPE_META[t.fields.type];
              const sm = STATUS_META[t.status];
              const tag = TAG_META[getTag(t)];
              const prioClass = t.priority === 'high' ? styles.prioHigh : t.priority === 'medium' ? styles.prioMedium : styles.prioLow;
              return (
                <tr key={t.id} onClick={() => onOpenTicket(t.id)}>
                  <td>
                    <div className={styles.tkId}>{t.id}</div>
                  </td>
                  <td>
                    <span className={styles.typeTag}>
                      <span className={styles.typeDot} style={{ background: `var(${tm.dotVar})` }} />
                      {tm.label}
                    </span>
                  </td>
                  <td>
                    <div className={styles.tkLeader}>{t.leaderName}</div>
                  </td>
                  <td>
                    <span className={`${styles.tagChip} ${styles[tag.cls]}`}>{tag.label}</span>
                  </td>
                  <td>
                    <span className={styles.tkId}>{t.submittedAt}</span>
                  </td>
                  <td>
                    <span className={`${styles.prio} ${prioClass}`}>{t.priority.charAt(0).toUpperCase() + t.priority.slice(1)}</span>
                  </td>
                  <td>
                    <span className={`${styles.chip} ${styles[sm.cls]}`}>{sm.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
