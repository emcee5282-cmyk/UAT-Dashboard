'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { Download, MoreHorizontal, UserPlus } from 'lucide-react';
import UserAvatar from '@/app/components/UserAvatar';
import SearchableCombobox from '@/app/components/SearchableCombobox';
import Toast, { type ToastState } from '@/app/components/Toast';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { EXPORT_BUTTON_CLASS, PRIMARY_TOOLBAR_BUTTON_CLASS, SearchPill, TD_CLASS, TH_CLASS, TR_CLASS } from '@/app/components/ListToolbar';
import { classifyFetchError } from '@/app/lib/errors';
import type { AdminUserRow } from '@/app/lib/auth/userAdmin';
import { useSession } from '@/app/lib/auth/useSession';
import { TEAMS, isKnownTeam } from '@/app/lib/auth/teams';
import { FormField, Modal, ModalActions, TempPasswordModal, formatDateTime, inputClass } from './dialogs';

type RoleOption = { key: string; name: string; needsLeader: boolean };
type Leader = { id: number; name: string };
type FormState = { username: string; name: string; role: string; team: string; leaderName: string };
type ConfirmAction = 'reset_password' | 'deactivate' | 'reactivate' | 'unlock';

type StatusFilter = 'all' | 'active' | 'deactivated';

// Status pill (dot + label). Locked is still an active account, just
// temporarily blocked by failed logins — amber, with Unlock in its ⋯ menu.
const STATUS_PILL: Record<AdminUserRow['status'], { pill: string; dot: string }> = {
  Active: { pill: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400', dot: 'bg-emerald-500' },
  Locked: { pill: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400', dot: 'bg-amber-500' },
  Deactivated: { pill: 'bg-[#F1F2F5] text-[#6B7280] dark:bg-[#1A1E29] dark:text-[#9198AC]', dot: 'bg-[#9CA3AF]' },
};

const PILL_CLASS = 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium';
const ACCENT_SOFT_BG = 'bg-[color-mix(in_srgb,var(--ui-accent)_10%,transparent)]';
const FILTER_SELECT_CLASS =
  'h-8 shrink-0 appearance-none rounded-full border border-[#E5E7EB] bg-white pl-[13px] pr-8 text-[11px] text-[#111827] outline-none transition-colors focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent)]/20 dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#E5E7EB]';
const ROW_OUTLINE_BUTTON_CLASS =
  'h-7 rounded-lg border border-[#E2E8F0] bg-white px-3 text-[11px] font-medium text-[#475569] transition-colors hover:border-[var(--ui-accent)] hover:bg-[#F1F5F9] dark:border-[#262B38] dark:bg-[#12151D] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// Row initials from the display name, ignoring any "(…)" suffix:
// "Leader Test (JAVED)" → "LT", "Kenta" → "K".
function rowInitials(u: AdminUserRow): string {
  const words = (u.name || u.username).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return u.username.slice(0, 1).toUpperCase();
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}

const CONFIRM_COPY: Record<ConfirmAction, { title: string; body: string; cta: string; destructive?: boolean }> = {
  reset_password: {
    title: 'Reset password',
    body: "The password goes back to the user's username. They are signed out everywhere and must change it at next login.",
    cta: 'Reset password',
  },
  deactivate: {
    title: 'Deactivate user',
    body: 'The user is signed out immediately and can no longer log in. Their history is kept; you can reactivate them later.',
    cta: 'Deactivate',
    destructive: true,
  },
  reactivate: { title: 'Reactivate user', body: 'The user will be able to log in again.', cta: 'Reactivate' },
  unlock: { title: 'Unlock user', body: 'Clears the failed-login lock so the user can try again right away.', cta: 'Unlock' },
};

// `tabs` is the page's Users | Roles switcher — rendered here so Export and
// Add user can sit on the same row, on the right.
export default function UsersTab({ refreshKey, initialRole, tabs }: { refreshKey: number; initialRole?: string; tabs: ReactNode }) {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const session = useSession();
  // Each (refreshKey, nonce) pair is one request; loading = latest not finished.
  const [nonce, setNonce] = useState(0);
  const requestKey = `${refreshKey}:${nonce}`;
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const loading = doneKey !== requestKey;
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Pre-set when arriving from a role's user count on the Roles tab.
  const [roleFilter, setRoleFilter] = useState(initialRole ?? 'all');
  const [teamFilter, setTeamFilter] = useState('all');  const [toast, setToast] = useState<ToastState>(null);

  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [form, setForm] = useState<FormState>({ username: '', name: '', role: '', team: '', leaderName: '' });
  const [formError, setFormError] = useState<{ field?: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ user: AdminUserRow; action: ConfirmAction } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/users?t=${Date.now()}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ? `${res.status} ${data.error}` : `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setError(null);
        setUsers(data.users);
        setRoles(data.roles);
        setLeaders(data.leaders);
        setCurrentUserId(data.currentUserId);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive && setDoneKey(requestKey));
    return () => {
      alive = false;
    };
  }, [requestKey]);

  // Active (incl. Locked) first, then deactivated — stable within each group.
  const sortedUsers = useMemo(() => {
    if (!users) return [];
    return [...users.filter((u) => u.status !== 'Deactivated'), ...users.filter((u) => u.status === 'Deactivated')];
  }, [users]);

  const statusCounts = useMemo(() => {
    const deactivated = sortedUsers.filter((u) => u.status === 'Deactivated').length;
    return { all: sortedUsers.length, active: sortedUsers.length - deactivated, deactivated };
  }, [sortedUsers]);

  // The fixed list, plus any older team still set on someone.
  const teams = useMemo(
    () => [...TEAMS, ...Array.from(new Set(sortedUsers.map((u) => u.team).filter((t): t is string => !!t && !isKnownTeam(t)))).sort()],
    [sortedUsers]
  );

  // All client-side over the loaded list — no refetch.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedUsers.filter(
      (u) =>
        (statusFilter === 'all' || (statusFilter === 'deactivated') === (u.status === 'Deactivated')) &&
        (roleFilter === 'all' || u.role === roleFilter) &&
        (teamFilter === 'all' || u.team === teamFilter) &&
        (!q || [u.username, u.name].some((v) => v?.toLowerCase().includes(q)))
    );
  }, [sortedUsers, search, statusFilter, roleFilter, teamFilter]);

  const roleNeedsLeader = (key: string) => roles.find((r) => r.key === key)?.needsLeader ?? false;

  const openCreate = () => {
    setForm({ username: '', name: '', role: roles.find((r) => r.key === 'viewer')?.key ?? roles[0]?.key ?? '', team: '', leaderName: '' });
    setEditing(null);
    setFormError(null);
    setFormMode('create');
  };

  const openEdit = (user: AdminUserRow) => {
    setForm({ username: user.username, name: user.name ?? '', role: user.role, team: user.team ?? '', leaderName: user.leaderName ?? '' });
    setEditing(user);
    setFormError(null);
    setFormMode('edit');
  };

  const submitForm = async () => {
    if (saving) return;
    const needsLeader = roleNeedsLeader(form.role);
    const leaderId = needsLeader ? (leaders.find((l) => l.name === form.leaderName)?.id ?? null) : null;
    if (needsLeader && !leaderId) {
      setFormError({ field: 'leaderId', message: 'Pick the leader name this account belongs to.' });
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = { name: form.name, role: form.role, team: form.team, leaderId };
      const res =
        formMode === 'create'
          ? await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, username: form.username }) })
          : await fetch(`/api/admin/users/${editing!.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, action: 'update' }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError({ field: data.field, message: data.error || 'Could not save.' });
        return;
      }
      setFormMode(null);
      if (formMode === 'create') setTempPassword({ username: data.username, password: data.tempPassword });
      else setToast({ type: 'success', message: 'User updated.' });
      load();
    } catch {
      setFormError({ message: 'Something went wrong. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm || confirming) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/admin/users/${confirm.user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: confirm.action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setToast({ type: 'error', message: data.error || 'Action failed.' });
      else if (confirm.action === 'reset_password') setTempPassword({ username: data.username, password: data.tempPassword });
      else setToast({ type: 'success', message: `${CONFIRM_COPY[confirm.action].cta}: done.` });
      setConfirm(null);
      load();
    } finally {
      setConfirming(false);
    }
  };

  const handleExport = () => {
    const sheet = XLSX.utils.json_to_sheet(
      rows.map((u) => ({
        Username: u.username,
        'Display name': u.name ?? '',
        Role: u.roleLabel,
        'Leader name': u.leaderName ?? '',
        Team: u.team ?? '',
        Status: u.status,
        'Last login': u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '',
      }))
    );
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Users');
    XLSX.writeFile(book, `Users_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const isSelf = (u: AdminUserRow) => u.id === currentUserId;
  const firstLoad = loading && !users;

  if (error && !users) return <ConnectionErrorState error={classifyFetchError(error)} onRetry={load} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
        {/* The tab switcher carries its own mb-4 for when it stacks alone — not
            wanted on a shared row, where it would push the buttons off-center. */}
        <div className="[&>div]:mb-0">{tabs}</div>
        <div className="flex items-center gap-[10px]">
          <button type="button" onClick={handleExport} disabled={!users || rows.length === 0} aria-label="Export to Excel" title="Export" className={EXPORT_BUTTON_CLASS}>
            <Download size={13} />
            <span className="hidden xl:inline">Export</span>
          </button>
          <button type="button" onClick={openCreate} disabled={firstLoad} className={PRIMARY_TOOLBAR_BUTTON_CLASS}>
            <UserPlus size={13} />
            Add user
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[#DEE1E8] bg-white dark:border-[#262B38] dark:bg-[#12151D]">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3 dark:border-[#262B38]">
          <div className="flex items-center gap-1">
            {(
              [
                ['all', 'All', statusCounts.all],
                ['active', 'Active', statusCounts.active],
                ['deactivated', 'Deactivated', statusCounts.deactivated],
              ] as const
            ).map(([key, label, count]) => {
              const selected = statusFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                  aria-pressed={selected}
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] transition-colors ${
                    selected ? `${ACCENT_SOFT_BG} font-semibold text-[var(--ui-accent)]` : 'font-medium text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {label}
                  <span
                    className={`rounded-md px-1.5 text-[10.5px] font-medium ${
                      selected ? 'bg-white/70 text-[var(--ui-accent)] dark:bg-white/10' : 'bg-[#F1F2F5] text-muted-foreground dark:bg-[#1A1E29]'
                    }`}
                  >
                    {firstLoad ? '−' : count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchPill value={search} onChange={setSearch} loading={firstLoad} placeholder="Search name or username" />
            <FilterSelect label="Filter by role" value={roleFilter} onChange={setRoleFilter} allLabel="All roles" options={roles.map((r) => ({ value: r.key, label: r.name }))} />
            <FilterSelect label="Filter by team" value={teamFilter} onChange={setTeamFilter} allLabel="All teams" options={teams.map((t) => ({ value: t, label: t }))} />
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-auto">
          {loading && <TableLoadingSpinner overlay />}
          <table className="w-full min-w-[920px] table-fixed border-separate border-spacing-0 text-xs">
            <colgroup>
              <col style={{ width: '29%' }} />
              <col style={{ width: '19%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '11%' }} />
            </colgroup>
            <thead>
              <tr className="h-[38px]">
                {['User', 'Role', 'Team', 'Status', 'Last login'].map((h) => (
                  <th key={h} className={`${TH_CLASS} text-left`}>
                    {h}
                  </th>
                ))}
                <th className={TH_CLASS} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {!loading && users && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">
                    No users match.
                  </td>
                </tr>
              ) : (
                !loading &&
                rows.map((u, i) => {
                  const deactivated = u.status === 'Deactivated';
                  const self = isSelf(u);
                  const textTone = deactivated ? 'text-muted-foreground' : 'text-foreground';
                  return (
                    <tr
                      key={u.id}
                      className={`${TR_CLASS} ${deactivated ? 'bg-[#FAFBFC] dark:bg-white/[0.015]' : ''}`}
                      style={{ '--stagger-delay': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
                    >
                      <td className={`${TD_CLASS} py-2.5`}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          {/* Own row follows the live session, so a photo saved
                              from Profile shows here without a refresh. */}
                          <UserAvatar
                            user={{ name: u.name, username: u.username, avatar: self && session ? session.avatar : u.avatar }}
                            initials={rowInitials(u)}
                            size={34}
                            muted={deactivated}
                          />
                          <div className="min-w-0">
                            <p className="flex min-w-0 items-center gap-1.5">
                              <span className={`truncate text-[12px] font-semibold ${textTone}`}>{u.name || u.username}</span>
                              {self && (
                                <span className={`shrink-0 rounded-md ${ACCENT_SOFT_BG} px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-[var(--ui-accent)]`}>YOU</span>
                              )}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">@{u.username}</p>
                          </div>
                        </div>
                      </td>
                      <td className={`${TD_CLASS} ${textTone}`}>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{u.roleLabel}</span>
                          {u.leaderName && (
                            <span className="shrink-0 rounded-md border border-[#E5E7EB] bg-[#F7F8FA] px-1.5 py-px text-[10px] font-medium text-[#6B7280] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]">
                              {u.leaderName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${TD_CLASS} truncate ${textTone}`}>{u.team || '−'}</td>
                      <td className={`${TD_CLASS} whitespace-nowrap`}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`${PILL_CLASS} ${STATUS_PILL[u.status].pill}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_PILL[u.status].dot}`} />
                            {u.status}
                          </span>
                          {u.mustChangePassword && !deactivated && (
                            <span className={`${PILL_CLASS} bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400`}>Temp password</span>
                          )}
                        </span>
                      </td>
                      <td className={`${TD_CLASS} whitespace-nowrap ${textTone}`}>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                      <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                        <div className="inline-flex items-center gap-1">
                          {deactivated ? (
                            <button
                              type="button"
                              onClick={() => setConfirm({ user: u, action: 'reactivate' })}
                              className={`h-7 rounded-lg ${ACCENT_SOFT_BG} px-3 text-[11px] font-semibold text-[var(--ui-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--ui-accent)_16%,transparent)]`}
                            >
                              Reactivate
                            </button>
                          ) : (
                            <button type="button" onClick={() => openEdit(u)} className={ROW_OUTLINE_BUTTON_CLASS}>
                              Edit
                            </button>
                          )}
                          {self ? (
                            <span className="inline-block w-7" aria-hidden />
                          ) : (
                            <MoreMenu
                              items={
                                deactivated
                                  ? [{ label: 'Edit', onSelect: () => openEdit(u) }]
                                  : [
                                      ...(u.status === 'Locked' ? [{ label: 'Unlock', onSelect: () => setConfirm({ user: u, action: 'unlock' }) }] : []),
                                      { label: 'Reset password', onSelect: () => setConfirm({ user: u, action: 'reset_password' }) },
                                      'divider' as const,
                                      { label: 'Deactivate', danger: true, onSelect: () => setConfirm({ user: u, action: 'deactivate' }) },
                                    ]
                              }
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#E2E8F0] px-4 py-2.5 text-[11px] text-muted-foreground dark:border-[#262B38]">
          <span>{firstLoad ? ' ' : `Showing ${rows.length} of ${statusCounts.all} user${statusCounts.all === 1 ? '' : 's'}`}</span>        </div>
      </div>
      {formMode && (
        <Modal title={formMode === 'create' ? 'Add user' : `Edit ${editing?.username}`} onClose={() => setFormMode(null)} busy={saving}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitForm();
            }}
            className="space-y-3.5"
          >
            {formMode === 'create' && (
              <FormField label="Username" error={formError?.field === 'username' ? formError.message : undefined} hint="Lowercase letters, numbers, dot, dash, underscore.">
                <input autoFocus value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase() }))} autoComplete="off" className={inputClass} />
              </FormField>
            )}
            <FormField label="Display name" error={formError?.field === 'name' ? formError.message : undefined}>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputClass} />
            </FormField>
            <FormField
              label="Role"
              error={formError?.field === 'role' ? formError.message : undefined}
              hint={editing && isSelf(editing) ? 'You cannot change your own role.' : undefined}
            >
              <select
                value={form.role}
                disabled={!!editing && isSelf(editing)}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                className={`${inputClass} disabled:opacity-60`}
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </FormField>
            {roleNeedsLeader(form.role) && (
              <FormField
                label="Leader name"
                error={formError?.field === 'leaderId' ? formError.message : undefined}
                hint="This role raises tickets — it only sees this leader's own shops/agents."
              >
                <SearchableCombobox
                  value={form.leaderName}
                  onChange={(v) => setForm((f) => ({ ...f, leaderName: v }))}
                  options={leaders.map((l) => l.name)}
                  placeholder="Search leader"
                  error={formError?.field === 'leaderId'}
                />
              </FormField>
            )}
            <FormField label="Team" hint="Optional." error={formError?.field === 'team' ? formError.message : undefined}>
              <select value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))} className={inputClass}>
                <option value="">No team</option>
                {/* A team set before the fixed list stays selectable for that user. */}
                {form.team && !isKnownTeam(form.team) && <option value={form.team}>{form.team}</option>}
                {TEAMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            {formError && !formError.field && <p className="text-[12px] font-medium text-rose-600 dark:text-rose-400">{formError.message}</p>}
            <ModalActions onCancel={() => setFormMode(null)} confirmLabel={formMode === 'create' ? 'Create user' : 'Save changes'} busy={saving} submit />
          </form>
        </Modal>
      )}

      {confirm && (
        <Modal title={CONFIRM_COPY[confirm.action].title} onClose={() => setConfirm(null)} busy={confirming}>
          <p className="text-[12.5px] text-foreground">
            <span className="font-semibold">{confirm.user.username}</span>
            {confirm.user.name ? ` (${confirm.user.name})` : ''}
          </p>
          <p className="mt-1.5 text-[12px] text-muted-foreground">{CONFIRM_COPY[confirm.action].body}</p>
          <ModalActions
            onCancel={() => setConfirm(null)}
            onConfirm={runConfirm}
            confirmLabel={CONFIRM_COPY[confirm.action].cta}
            busy={confirming}
            destructive={CONFIRM_COPY[confirm.action].destructive}
          />
        </Modal>
      )}

      {tempPassword && <TempPasswordModal {...tempPassword} onClose={() => setTempPassword(null)} />}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={FILTER_SELECT_CLASS}>
        <option value="all">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7280]" aria-hidden>
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

type MenuItem = { label: string; onSelect: () => void; danger?: boolean } | 'divider';

// Row "⋯" menu. Portal + fixed position so the table's own scroll box
// can't clip it; closes on outside click, Escape, scroll or resize.
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal size={15} />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="z-[999] w-44 rounded-xl border border-border bg-white p-1 shadow-xl dark:border-[#262B38] dark:bg-[#12151D]"
          >
            {items.map((item, i) =>
              item === 'divider' ? (
                <div key={`divider-${i}`} className="my-1 border-t border-[#F1F5F9] dark:border-[#1A1E29]" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                    item.danger
                      ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10'
                      : 'text-[#475569] hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5'
                  }`}
                >
                  {item.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </>
  );
}
