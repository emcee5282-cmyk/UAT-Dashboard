'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, UserPlus } from 'lucide-react';
import SearchableCombobox from '@/app/components/SearchableCombobox';
import Toast, { type ToastState } from '@/app/components/Toast';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import {
  EXPORT_BUTTON_CLASS,
  PRIMARY_TOOLBAR_BUTTON_CLASS,
  SearchPill,
  TABLE_WRAPPER_CLASS,
  TD_CLASS,
  TH_CLASS,
  TR_CLASS,
  TextTabs,
  TextTabsSkeleton,
} from '@/app/components/ListToolbar';
import { classifyFetchError } from '@/app/lib/errors';
import type { AdminUserRow } from '@/app/lib/auth/userAdmin';
import { FormField, Modal, ModalActions, TempPasswordModal, formatDateTime, inputClass } from './dialogs';

type RoleOption = { key: string; name: string; needsLeader: boolean };
type Leader = { id: number; name: string };
type FormState = { username: string; name: string; role: string; team: string; leaderName: string };
type ConfirmAction = 'reset_password' | 'deactivate' | 'reactivate' | 'unlock';

const STATUS_BADGE: Record<AdminUserRow['status'], string> = {
  Active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400',
  Locked: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-400',
  Deactivated: 'border-border bg-muted/40 text-muted-foreground',
};

const CONFIRM_COPY: Record<ConfirmAction, { title: string; body: string; cta: string; destructive?: boolean }> = {
  reset_password: {
    title: 'Reset password',
    body: 'A new temporary password will be generated. The user is signed out everywhere and must change it at next login.',
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

export default function UsersTab({ refreshKey, initialRole }: { refreshKey: number; initialRole?: string }) {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  // Each (refreshKey, nonce) pair is one request; loading = latest not finished.
  const [nonce, setNonce] = useState(0);
  const requestKey = `${refreshKey}:${nonce}`;
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const loading = doneKey !== requestKey;
  const [error, setError] = useState<string | null>(null);
  const [roleTab, setRoleTab] = useState<string>(initialRole ?? 'all');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastState>(null);

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

  // Role tabs come from the database — a new role shows up here on its own.
  const roleTabs = useMemo(
    () => [
      { key: 'all', label: 'All', count: users?.length },
      ...roles.map((r) => ({ key: r.key, label: r.name, count: users?.filter((u) => u.role === r.key).length })),
    ],
    [roles, users]
  );

  const rows = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (roleTab === 'all' || u.role === roleTab) &&
        (!q || [u.username, u.name, u.roleLabel, u.team, u.leaderName, u.status].some((v) => v?.toLowerCase().includes(q)))
    );
  }, [users, roleTab, search]);

  const roleNeedsLeader = (key: string) => roles.find((r) => r.key === key)?.needsLeader ?? false;

  const openCreate = () => {
    setForm({ username: '', name: '', role: roleTab !== 'all' ? roleTab : (roles.find((r) => r.key === 'viewer')?.key ?? roles[0]?.key ?? ''), team: '', leaderName: '' });
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
        <div className="flex flex-wrap items-center gap-6">
          {firstLoad ? <TextTabsSkeleton count={5} /> : <TextTabs tabs={roleTabs} selected={roleTab} onSelect={setRoleTab} />}
          <SearchPill value={search} onChange={setSearch} loading={firstLoad} placeholder="Search users" />
        </div>
        <div className="flex items-center gap-[10px]">
          <button type="button" onClick={openCreate} disabled={firstLoad} className={PRIMARY_TOOLBAR_BUTTON_CLASS}>
            <UserPlus size={13} />
            Add user
          </button>
          <button type="button" onClick={handleExport} disabled={!users || rows.length === 0} aria-label="Export to Excel" title="Export" className={EXPORT_BUTTON_CLASS}>
            <Download size={13} />
            <span className="hidden xl:inline">Export</span>
          </button>
        </div>
      </div>

      <div className={TABLE_WRAPPER_CLASS}>
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[860px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col style={{ width: '15%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr className="h-[38px]">
              {['Username', 'Display name', 'Role', 'Team', 'Status', 'Last login'].map((h) => (
                <th key={h} className={`${TH_CLASS} text-left`}>
                  {h}
                </th>
              ))}
              <th className={`${TH_CLASS} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users && rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">
                  No users match.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
                <tr key={u.id} className={TR_CLASS}>
                  <td className={`${TD_CLASS} truncate font-medium text-foreground`}>
                    {u.username}
                    {isSelf(u) && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(you)</span>}
                  </td>
                  <td className={`${TD_CLASS} truncate text-foreground`}>{u.name || '−'}</td>
                  <td className={`${TD_CLASS} truncate text-foreground`}>
                    {u.roleLabel}
                    {u.leaderName && <span className="text-muted-foreground"> · {u.leaderName}</span>}
                  </td>
                  <td className={`${TD_CLASS} truncate text-foreground`}>{u.team || '−'}</td>
                  <td className={`${TD_CLASS} whitespace-nowrap`}>
                    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-medium ${STATUS_BADGE[u.status]}`}>{u.status}</span>
                    {u.mustChangePassword && u.status === 'Active' && <span className="ml-1.5 text-[10px] text-muted-foreground">temp pw</span>}
                  </td>
                  <td className={`${TD_CLASS} whitespace-nowrap text-foreground`}>{formatDateTime(u.lastLoginAt)}</td>
                  <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                    <div className="inline-flex items-center gap-0.5">
                      <RowButton onClick={() => openEdit(u)}>Edit</RowButton>
                      {!isSelf(u) && u.status !== 'Deactivated' && <RowButton onClick={() => setConfirm({ user: u, action: 'reset_password' })}>Reset password</RowButton>}
                      {u.status === 'Locked' && <RowButton onClick={() => setConfirm({ user: u, action: 'unlock' })}>Unlock</RowButton>}
                      {!isSelf(u) &&
                        (u.status === 'Deactivated' ? (
                          <RowButton onClick={() => setConfirm({ user: u, action: 'reactivate' })}>Reactivate</RowButton>
                        ) : (
                          <RowButton danger onClick={() => setConfirm({ user: u, action: 'deactivate' })}>
                            Deactivate
                          </RowButton>
                        ))}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
            <FormField label="Team" hint="Optional.">
              <input value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))} className={inputClass} />
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

function RowButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
        danger ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
