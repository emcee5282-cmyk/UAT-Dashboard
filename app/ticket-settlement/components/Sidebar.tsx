'use client';

import { ChevronLeft, History, LayoutDashboard, Table2, TrendingUp } from 'lucide-react';
import styles from '../settlement.module.css';

// The other three nav items (Balances / Today's Insight / Resolved log)
// are part of the mockup's own sidebar but have no destination in this
// prototype — rendered inert (no onClick) rather than wired to a real
// route, per "don't add features beyond what's described."
export default function Sidebar({ collapsed, onToggleCollapse, queueCount }: { collapsed: boolean; onToggleCollapse: () => void; queueCount: number }) {
  return (
    <div className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
      <div className={styles.sbTop}>
        <div className={styles.sbMark}>S</div>
        <div>
          <div className={styles.sbTitle}>Settlement</div>
          <div className={styles.sbSub}>Ops Console</div>
        </div>
      </div>
      <div className={styles.sbNav}>
        <button type="button" className={`${styles.sbItem} ${styles.active}`}>
          <Table2 />
          <span>Live Queue</span>
          <span className={styles.sbCount}>{queueCount}</span>
        </button>
        <button type="button" className={styles.sbItem} aria-disabled="true">
          <LayoutDashboard />
          <span>Balances</span>
        </button>
        <button type="button" className={styles.sbItem} aria-disabled="true">
          <TrendingUp />
          <span>Today&apos;s Insight</span>
        </button>
        <button type="button" className={styles.sbItem} aria-disabled="true">
          <History />
          <span>Resolved log</span>
        </button>
      </div>
      <div className={styles.sbBottom}>
        <button type="button" className={styles.sbCollapseBtn} onClick={onToggleCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <ChevronLeft size={14} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </div>
  );
}
