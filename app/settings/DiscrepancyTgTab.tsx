'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties } from 'react';
import { Pencil, Eye, EyeOff, Trash2, Plus, Loader2 } from 'lucide-react';

// Same editable-cell styling as Daily Txn Entry > Operations' own Deposit/
// Withdrawal grid (LedgerCard in app/daily-txn-entry/page.tsx) — duplicated
// locally rather than shared, since that style lives inline in that page
// and this tab is otherwise unrelated to it.
const INPUT_CLASS =
  'w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[12.5px] text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]';
const EDIT_BUTTON =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#5B57E0] hover:text-[#5B57E0] dark:border-[#262B38] dark:bg-[#1A1E29]';
const CANCEL_BUTTON =
  'whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] dark:border-[#262B38] dark:bg-[#1A1E29]';

function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

type SavedRow = { id: number; groupName: string; tgIdCashout: string | null; tgIdSendmoney: string | null };
type DraftRow = { groupName: string; tgIdCashout: string; tgIdSendmoney: string };

const EMPTY_ROW: DraftRow = { groupName: '', tgIdCashout: '', tgIdSendmoney: '' };
const TG_ID_PATTERN = /^-?\d+$/;

function toDraft(rows: SavedRow[]): DraftRow[] {
  return rows.map((r) => ({ groupName: r.groupName, tgIdCashout: r.tgIdCashout ?? '', tgIdSendmoney: r.tgIdSendmoney ?? '' }));
}
function idOk(v: string): boolean {
  return v === '' || TG_ID_PATTERN.test(v.trim());
}
function fmtId(v: string | null): string {
  return v ?? '';
}

// Threshold inputs show comma separators while typing (section 3's own
// "Show comma separators... but store a plain integer") — strip
// non-digits then reformat on every keystroke, same convention as a
// money input, rather than only formatting on blur.
function formatThresholdDraft(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits ? Number(digits).toLocaleString('en-US') : '';
}
function parseThresholdDraft(formatted: string): number {
  const digits = formatted.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

export default function DiscrepancyTgTab() {
  const [loading, setLoading] = useState(true);
  const [savedRows, setSavedRows] = useState<SavedRow[]>([]);
  const [savedToken, setSavedToken] = useState('');
  const [savedCashoutThreshold, setSavedCashoutThreshold] = useState(20000);
  const [savedSendmoneyThreshold, setSavedSendmoneyThreshold] = useState(10000);
  const [lastUpdate, setLastUpdate] = useState<{ updatedAt: string; updatedBy: string } | null>(null);
  const [leaders, setLeaders] = useState<string[]>([]);

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [cashoutThresholdDraft, setCashoutThresholdDraft] = useState('20,000');
  const [sendmoneyThresholdDraft, setSendmoneyThresholdDraft] = useState('10,000');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const groupNameRefs = useRef<(HTMLInputElement | null)[]>([]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch(`/api/configurations/discrepancy-tg?t=${Date.now()}`);
      const data = await res.json();
      setSavedRows(data.rows ?? []);
      setSavedToken(data.token ?? '');
      setSavedCashoutThreshold(data.cashoutThreshold ?? 20000);
      setSavedSendmoneyThreshold(data.sendmoneyThreshold ?? 10000);
      setLastUpdate(data.lastUpdate ?? null);
      setLeaders(data.leaders ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  useEffect(() => {
    if (focusRow !== null) {
      groupNameRefs.current[focusRow]?.focus();
      setFocusRow(null);
    }
  }, [focusRow]);

  function handleEdit() {
    setRows(toDraft(savedRows));
    setToken(savedToken);
    setCashoutThresholdDraft(savedCashoutThreshold.toLocaleString('en-US'));
    setSendmoneyThresholdDraft(savedSendmoneyThreshold.toLocaleString('en-US'));
    setEditing(true);
    setSaveError(null);
  }

  function handleCancel() {
    setRows(toDraft(savedRows));
    setToken(savedToken);
    setCashoutThresholdDraft(savedCashoutThreshold.toLocaleString('en-US'));
    setSendmoneyThresholdDraft(savedSendmoneyThreshold.toLocaleString('en-US'));
    setEditing(false);
    setConfirmRemove(null);
    setOpenDropdown(null);
    setSaveError(null);
  }

  function updateCell(i: number, key: keyof DraftRow, value: string) {
    setRows((current) => current.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  function addRow() {
    setRows((current) => {
      const next = [...current, { ...EMPTY_ROW }];
      setFocusRow(next.length - 1);
      return next;
    });
    setConfirmRemove(null);
  }

  function removeRow(i: number) {
    setRows((current) => current.filter((_, idx) => idx !== i));
    setConfirmRemove(null);
  }

  // Tab/newline-separated paste fills across (columns) and down (rows) from
  // the focused cell, creating new rows as needed — matches the reference
  // mock exactly. A plain single-value paste (no tab/newline) is left to
  // the browser's normal paste behavior.
  function handlePaste(i: number, col: 0 | 1 | 2, e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const lines = text.trim().split(/\r?\n/);
    setRows((current) => {
      const next = [...current];
      lines.forEach((line, k) => {
        const idx = i + k;
        if (!next[idx]) next[idx] = { ...EMPTY_ROW };
        line.split('\t').forEach((cellVal, j) => {
          const targetCol = col + j;
          const trimmed = cellVal.trim();
          if (targetCol === 0) next[idx] = { ...next[idx], groupName: trimmed.toUpperCase() };
          else if (targetCol === 1) next[idx] = { ...next[idx], tgIdCashout: trimmed };
          else if (targetCol === 2) next[idx] = { ...next[idx], tgIdSendmoney: trimmed };
        });
      });
      return next;
    });
    setOpenDropdown(null);
  }

  // Only the LATER occurrence of a repeated name is flagged — per spec
  // ("the later row turns red").
  function isDuplicate(i: number): boolean {
    const name = rows[i]?.groupName.trim();
    if (!name) return false;
    return rows.some((r, j) => j < i && r.groupName.trim() === name);
  }
  function rowBlockingError(i: number): string | null {
    const r = rows[i];
    if (!r) return null;
    const name = r.groupName.trim();
    const hasId = Boolean(r.tgIdCashout.trim() || r.tgIdSendmoney.trim());
    if (!name && !hasId) return null; // fully empty — dropped silently on save
    if (isDuplicate(i)) return 'Leader group already exists';
    if (hasId && !name) return 'Group name required';
    if (!idOk(r.tgIdCashout)) return 'Invalid TG ID Cashout';
    if (!idOk(r.tgIdSendmoney)) return 'Invalid TG ID Send Money';
    return null;
  }
  function isLeaderNotFound(i: number): boolean {
    const r = rows[i];
    if (!r) return false;
    const name = r.groupName.trim();
    if (!name || isDuplicate(i)) return false;
    return !leaders.includes(name);
  }

  const cashoutThresholdInvalid = cashoutThresholdDraft.trim() === '';
  const sendmoneyThresholdInvalid = sendmoneyThresholdDraft.trim() === '';
  const hasBlockingError = rows.some((_, i) => rowBlockingError(i) !== null) || cashoutThresholdInvalid || sendmoneyThresholdInvalid;
  const isDirty =
    JSON.stringify(rows) !== JSON.stringify(toDraft(savedRows)) ||
    token !== savedToken ||
    parseThresholdDraft(cashoutThresholdDraft) !== savedCashoutThreshold ||
    parseThresholdDraft(sendmoneyThresholdDraft) !== savedSendmoneyThreshold;
  const canSave = editing && isDirty && !hasBlockingError && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/configurations/discrepancy-tg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          rows,
          cashoutThreshold: parseThresholdDraft(cashoutThresholdDraft),
          sendmoneyThreshold: parseThresholdDraft(sendmoneyThresholdDraft),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Save failed');
      setSavedRows(data.rows ?? []);
      setSavedToken(data.token ?? '');
      setSavedCashoutThreshold(data.cashoutThreshold ?? 20000);
      setSavedSendmoneyThreshold(data.sendmoneyThreshold ?? 10000);
      setLastUpdate(data.lastUpdate ?? null);
      setEditing(false);
      setConfirmRemove(null);
      setOpenDropdown(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function Suggestions({ index }: { index: number }) {
    const query = rows[index].groupName.trim().toUpperCase();
    // Empty query (nothing typed yet) shows every known leader, not a
    // truncated preview — per explicit instruction. Typing then narrows
    // that same full list down to substring matches, no separate cap on
    // either list.
    const matches = query ? leaders.filter((l) => l.includes(query)) : leaders;
    const usedElsewhere = new Set(rows.filter((_, j) => j !== index).map((r) => r.groupName.trim()).filter(Boolean));
    return (
      <div className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-60 overflow-y-auto rounded-lg border border-[#DEE1E8] bg-white p-1 shadow-lg dark:border-[#262B38] dark:bg-[#12151D]">
        {matches.length === 0 ? (
          <div className="px-2.5 py-2 text-[11.5px] text-amber-600 dark:text-amber-400">⚠ Leader not found</div>
        ) : (
          matches.map((l) => {
            const used = usedElsewhere.has(l);
            const matchIdx = query ? l.indexOf(query) : -1;
            return (
              <div
                key={l}
                onMouseDown={(e) => {
                  if (used) return;
                  e.preventDefault();
                  updateCell(index, 'groupName', l);
                  setOpenDropdown(null);
                }}
                className={`rounded-md px-2.5 py-1.5 text-[12px] ${used ? 'cursor-default text-muted-foreground' : 'cursor-pointer hover:bg-[#EEF2FF] dark:hover:bg-[#1E2140]'}`}
              >
                {matchIdx >= 0 && query ? (
                  <>
                    {l.slice(0, matchIdx)}
                    <b className="text-[#4F46E5]">{l.slice(matchIdx, matchIdx + query.length)}</b>
                    {l.slice(matchIdx + query.length)}
                  </>
                ) : (
                  l
                )}
                {used && <span className="ml-1 text-[11px] text-muted-foreground">· already added</span>}
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[15px] font-bold text-foreground">Discrepancy TG</h2>
          </div>
          <p className="mt-[5px] text-[12px] text-muted-foreground">Telegram group IDs that receive each leader&apos;s discrepancy summary.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
            Last update: <span className="font-[500]! tabular-nums">{lastUpdate ? formatTimestamp(lastUpdate.updatedAt) : 'Never updated'}</span>
          </span>
          {editing ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button onClick={handleCancel} className={CANCEL_BUTTON}>
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className={`whitespace-nowrap rounded-[9px] border-none px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-40 ${
                  saved ? 'bg-[#1C9A5B]' : 'bg-[#1B2129] hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]'
                }`}
              >
                {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <button onClick={handleEdit} className={EDIT_BUTTON}>
              <Pencil size={12} strokeWidth={2.25} />
              Edit
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
          <Loader2 size={16} className="mr-2 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {saveError && (
            <div className="mb-3 rounded-md border border-[color:var(--dd-neg)]/40 bg-[color:var(--dd-neg)]/5 px-3 py-2 text-[11.5px] text-[color:var(--dd-neg)]">{saveError}</div>
          )}

          {/* TG Token box */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-[#EFF1F4] bg-[#FAFBFC] px-3.5 py-3 dark:border-[#1A1E29] dark:bg-[#0E1119]">
            <label className="shrink-0 text-[11.5px] font-bold text-foreground">🔑 TG Token</label>
            <input
              type={tokenVisible ? 'text' : 'password'}
              value={editing ? token : savedToken}
              readOnly={!editing}
              onChange={(e) => editing && setToken(e.target.value)}
              placeholder="Paste bot token"
              className="min-w-[200px] flex-1 rounded-md border border-[#DEE1E8] bg-white px-2.5 py-1.5 text-[12px] text-foreground focus:border-[#5B57E0] focus:outline-none dark:border-[#262B38] dark:bg-[#12151D]"
            />
            <button
              type="button"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? 'Hide' : 'Show'}
              className="shrink-0 rounded-md border border-[#DEE1E8] p-1.5 text-muted-foreground hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38]"
            >
              {tokenVisible ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <p className="basis-full text-[11px] text-muted-foreground">The Telegram bot that sends the summaries. The bot must be added to every group below.</p>

            <div className="mt-1 flex basis-full flex-wrap items-center gap-5 border-t border-[#EFF1F4] pt-3 dark:border-[#1A1E29]">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#1e3a8a]" />
                <label className="shrink-0 text-[11.5px] font-bold text-foreground">Cashout threshold</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={editing ? cashoutThresholdDraft : savedCashoutThreshold.toLocaleString('en-US')}
                  readOnly={!editing}
                  onChange={(e) => editing && setCashoutThresholdDraft(formatThresholdDraft(e.target.value))}
                  className={`w-[110px] rounded-md border bg-white px-2.5 py-1.5 text-right text-[12px] tabular-nums text-foreground focus:outline-none dark:bg-[#12151D] ${
                    editing && cashoutThresholdInvalid
                      ? 'border-[color:var(--dd-neg)] shadow-[0_0_0_1.5px_var(--dd-neg)]'
                      : 'border-[#DEE1E8] focus:border-[#5B57E0] dark:border-[#262B38]'
                  }`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#8a4b00]" />
                <label className="shrink-0 text-[11.5px] font-bold text-foreground">Send Money threshold</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={editing ? sendmoneyThresholdDraft : savedSendmoneyThreshold.toLocaleString('en-US')}
                  readOnly={!editing}
                  onChange={(e) => editing && setSendmoneyThresholdDraft(formatThresholdDraft(e.target.value))}
                  className={`w-[110px] rounded-md border bg-white px-2.5 py-1.5 text-right text-[12px] tabular-nums text-foreground focus:outline-none dark:bg-[#12151D] ${
                    editing && sendmoneyThresholdInvalid
                      ? 'border-[color:var(--dd-neg)] shadow-[0_0_0_1.5px_var(--dd-neg)]'
                      : 'border-[#DEE1E8] focus:border-[#5B57E0] dark:border-[#262B38]'
                  }`}
                />
              </div>
              <p className="basis-full text-[11px] text-muted-foreground">
                Photos show only shops with Agent Withdrawal &ge; the threshold. The Full Shop List PDF always shows all shops.
              </p>
            </div>
          </div>

          {!editing ? (
            // Read-only view — plain text, no inputs, no search/remove/add.
            <div className="overflow-x-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
              <table className="w-full table-fixed border-collapse text-[12.5px]">
                <colgroup>
                  <col style={{ width: '34%' }} />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                      Group Name
                    </th>
                    <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                      TG ID Cashout
                    </th>
                    <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                      TG ID Send Money
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {savedRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                        No groups configured yet.
                      </td>
                    </tr>
                  ) : (
                    savedRows.map((r) => (
                      <tr key={r.id} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                        <td className="px-3 py-2 font-medium text-foreground">{r.groupName}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-foreground">{fmtId(r.tgIdCashout)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-foreground">{fmtId(r.tgIdSendmoney)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            // Edit mode — live search, paste-fill, remove-row confirm, add row.
            <div className="relative">
              {confirmRemove !== null && <div className="fixed inset-0 z-10" onClick={() => setConfirmRemove(null)} />}
              <div className="overflow-visible rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
                <table className="w-full table-fixed border-collapse text-[12.5px]">
                  <colgroup>
                    <col style={{ width: '34%' }} />
                    <col />
                    <col />
                    <col style={{ width: 44 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Group Name
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        TG ID Cashout
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        TG ID Send Money
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] dark:border-[#1A1E29] dark:bg-[#0E1119]" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const savedDraft = toDraft(savedRows)[i] ?? EMPTY_ROW;
                      const dirty = JSON.stringify(r) !== JSON.stringify(savedDraft);
                      const blockingError = rowBlockingError(i);
                      const notFound = isLeaderNotFound(i);
                      const nameCellStyle: CSSProperties | undefined = dirty ? { boxShadow: 'inset 3px 0 0 var(--ui-accent)' } : undefined;
                      return (
                        <tr key={i} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                          <td className="relative px-0 py-0" style={nameCellStyle}>
                            <input
                              ref={(el) => {
                                groupNameRefs.current[i] = el;
                              }}
                              value={r.groupName}
                              onChange={(e) => {
                                updateCell(i, 'groupName', e.target.value.toUpperCase());
                                setOpenDropdown(i);
                              }}
                              onFocus={() => {
                                setOpenDropdown(i);
                                setConfirmRemove(null);
                              }}
                              onBlur={() => {
                                blurTimer.current = setTimeout(() => setOpenDropdown((cur) => (cur === i ? null : cur)), 150);
                              }}
                              onPaste={(e) => handlePaste(i, 0, e)}
                              placeholder="Search leader…"
                              className={INPUT_CLASS}
                            />
                            {openDropdown === i && <Suggestions index={i} />}
                            {openDropdown !== i && blockingError && (
                              <div className="px-2 pb-1.5 text-[10.5px] text-[color:var(--dd-neg)]">⚠ {blockingError}</div>
                            )}
                            {openDropdown !== i && !blockingError && notFound && (
                              <div className="px-2 pb-1.5 text-[10.5px] text-amber-600 dark:text-amber-400">⚠ Leader not found</div>
                            )}
                          </td>
                          <td className={`px-0 py-0 text-right ${!idOk(r.tgIdCashout) ? 'shadow-[inset_0_0_0_1.5px_var(--dd-neg)] bg-[color:var(--dd-neg)]/5' : ''}`}>
                            <input
                              value={r.tgIdCashout}
                              onChange={(e) => updateCell(i, 'tgIdCashout', e.target.value)}
                              onPaste={(e) => handlePaste(i, 1, e)}
                              className={`${INPUT_CLASS} text-right tabular-nums`}
                            />
                          </td>
                          <td className={`px-0 py-0 text-right ${!idOk(r.tgIdSendmoney) ? 'shadow-[inset_0_0_0_1.5px_var(--dd-neg)] bg-[color:var(--dd-neg)]/5' : ''}`}>
                            <input
                              value={r.tgIdSendmoney}
                              onChange={(e) => updateCell(i, 'tgIdSendmoney', e.target.value)}
                              onPaste={(e) => handlePaste(i, 2, e)}
                              className={`${INPUT_CLASS} text-right tabular-nums`}
                            />
                          </td>
                          <td className="relative px-0 py-0 text-center align-middle">
                            <button
                              type="button"
                              onClick={() => setConfirmRemove((cur) => (cur === i ? null : i))}
                              title="Remove row"
                              className="rounded p-1.5 text-muted-foreground hover:text-[color:var(--dd-neg)]"
                            >
                              <Trash2 size={14} />
                            </button>
                            {confirmRemove === i && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-1 top-full z-20 mt-1 w-[230px] rounded-lg border border-[#DEE1E8] bg-white p-3 text-left shadow-lg dark:border-[#262B38] dark:bg-[#12151D]"
                              >
                                <p className="mb-2.5 text-[12px] leading-snug text-foreground">
                                  Remove <b>{r.groupName.trim() || 'this row'}</b>? It will be deleted when you click Save.
                                </p>
                                <div className="flex justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmRemove(null)}
                                    className="rounded-md border border-[#DEE1E8] bg-white px-2.5 py-1 text-[11.5px] text-foreground dark:border-[#262B38] dark:bg-[#1A1E29]"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeRow(i)}
                                    className="rounded-md border border-[color:var(--dd-neg)] bg-[color:var(--dd-neg)] px-2.5 py-1 text-[11.5px] font-medium text-white"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                onClick={addRow}
                className="mt-2.5 inline-flex items-center gap-1 rounded-md border border-[#DEE1E8] bg-white px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29]"
              >
                <Plus size={13} /> Add row
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
