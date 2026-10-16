'use client';

// Settings > Unreconciled TG — a separate feature from Discrepancy TG
// (own token, own group rows). Simpler than Discrepancy TG's own tab:
// Group Name is free text (no leader search/dropdown/forced uppercase —
// a group here isn't routed to a specific leader, every configured group
// gets the same broadcast), and there are no thresholds.
import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties } from 'react';
import { Pencil, Eye, EyeOff, Trash2, Plus, Loader2 } from 'lucide-react';

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

type SavedRow = { id: number; groupName: string; tgId: string };
type DraftRow = { groupName: string; tgId: string };

const EMPTY_ROW: DraftRow = { groupName: '', tgId: '' };
const TG_ID_PATTERN = /^-?\d+$/;

function toDraft(rows: SavedRow[]): DraftRow[] {
  return rows.map((r) => ({ groupName: r.groupName, tgId: r.tgId }));
}
function idOk(v: string): boolean {
  return v === '' || TG_ID_PATTERN.test(v.trim());
}

export default function UnreconciledTgTab() {
  const [loading, setLoading] = useState(true);
  const [savedRows, setSavedRows] = useState<SavedRow[]>([]);
  const [savedToken, setSavedToken] = useState('');
  const [lastUpdate, setLastUpdate] = useState<{ updatedAt: string; updatedBy: string } | null>(null);

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const groupNameRefs = useRef<(HTMLInputElement | null)[]>([]);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch(`/api/configurations/unreconciled-tg?t=${Date.now()}`);
      const data = await res.json();
      setSavedRows(data.rows ?? []);
      setSavedToken(data.token ?? '');
      setLastUpdate(data.lastUpdate ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
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
    setEditing(true);
    setSaveError(null);
  }

  function handleCancel() {
    setRows(toDraft(savedRows));
    setToken(savedToken);
    setEditing(false);
    setConfirmRemove(null);
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

  // Tab/newline-separated paste fills across (columns) and down (rows)
  // from the focused cell, creating new rows as needed — same convention
  // as Discrepancy TG's own paste handler.
  function handlePaste(i: number, col: 0 | 1, e: ClipboardEvent<HTMLInputElement>) {
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
          if (targetCol === 0) next[idx] = { ...next[idx], groupName: trimmed };
          else if (targetCol === 1) next[idx] = { ...next[idx], tgId: trimmed };
        });
      });
      return next;
    });
  }

  // Only the LATER occurrence of a repeated TG ID is flagged (same
  // "later row turns red" convention Discrepancy TG uses for names).
  function isDuplicateTgId(i: number): boolean {
    const id = rows[i]?.tgId.trim();
    if (!id) return false;
    return rows.some((r, j) => j < i && r.tgId.trim() === id);
  }
  function rowBlockingError(i: number): string | null {
    const r = rows[i];
    if (!r) return null;
    const name = r.groupName.trim();
    const id = r.tgId.trim();
    if (!name && !id) return null; // fully empty — dropped silently on save
    if (!name) return 'Group name required';
    if (!id) return 'TG ID required';
    if (!idOk(r.tgId)) return 'Invalid TG ID';
    if (isDuplicateTgId(i)) return 'TG ID already exists';
    return null;
  }

  const hasBlockingError = rows.some((_, i) => rowBlockingError(i) !== null);
  const isDirty = JSON.stringify(rows) !== JSON.stringify(toDraft(savedRows)) || token !== savedToken;
  const canSave = editing && isDirty && !hasBlockingError && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/configurations/unreconciled-tg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Save failed');
      setSavedRows(data.rows ?? []);
      setSavedToken(data.token ?? '');
      setLastUpdate(data.lastUpdate ?? null);
      setEditing(false);
      setConfirmRemove(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[15px] font-bold text-foreground">Unreconciled TG</h2>
          </div>
          <p className="mt-[5px] text-[12px] text-muted-foreground">Telegram groups that receive the Unreconciled Balance summary.</p>
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
            <p className="basis-full text-[11px] text-muted-foreground">The Telegram bot that sends the summary. The bot must be added to every group below.</p>
          </div>

          {!editing ? (
            <div className="overflow-x-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
              <table className="w-full table-fixed border-collapse text-[12.5px]">
                <colgroup>
                  <col style={{ width: '50%' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                      Group Name
                    </th>
                    <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                      TG ID
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {savedRows.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                        No groups configured yet.
                      </td>
                    </tr>
                  ) : (
                    savedRows.map((r) => (
                      <tr key={r.id} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                        <td className="px-3 py-2 font-medium text-foreground">{r.groupName}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.tgId}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="relative">
              {confirmRemove !== null && <div className="fixed inset-0 z-10" onClick={() => setConfirmRemove(null)} />}
              <div className="overflow-visible rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
                <table className="w-full table-fixed border-collapse text-[12.5px]">
                  <colgroup>
                    <col style={{ width: '50%' }} />
                    <col />
                    <col style={{ width: 44 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        Group Name
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                        TG ID
                      </th>
                      <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] dark:border-[#1A1E29] dark:bg-[#0E1119]" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const savedDraft = toDraft(savedRows)[i] ?? EMPTY_ROW;
                      const dirty = JSON.stringify(r) !== JSON.stringify(savedDraft);
                      const blockingError = rowBlockingError(i);
                      const nameCellStyle: CSSProperties | undefined = dirty ? { boxShadow: 'inset 3px 0 0 var(--ui-accent)' } : undefined;
                      return (
                        <tr key={i} className="border-b border-[#EFF1F4] last:border-0 dark:border-[#1A1E29]">
                          <td className="relative px-0 py-0" style={nameCellStyle}>
                            <input
                              ref={(el) => {
                                groupNameRefs.current[i] = el;
                              }}
                              value={r.groupName}
                              onChange={(e) => updateCell(i, 'groupName', e.target.value)}
                              onFocus={() => setConfirmRemove(null)}
                              onPaste={(e) => handlePaste(i, 0, e)}
                              placeholder="Group name…"
                              className={INPUT_CLASS}
                            />
                            {blockingError && <div className="px-2 pb-1.5 text-[10.5px] text-[color:var(--dd-neg)]">⚠ {blockingError}</div>}
                          </td>
                          <td className={`px-0 py-0 text-right ${!idOk(r.tgId) ? 'shadow-[inset_0_0_0_1.5px_var(--dd-neg)] bg-[color:var(--dd-neg)]/5' : ''}`}>
                            <input
                              value={r.tgId}
                              onChange={(e) => updateCell(i, 'tgId', e.target.value)}
                              onPaste={(e) => handlePaste(i, 1, e)}
                              placeholder="-100…"
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
