'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import Toast, { type ToastState } from '@/app/components/Toast';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { PRIMARY_TOOLBAR_BUTTON_CLASS, SearchPill, TABLE_WRAPPER_CLASS, TD_CLASS, TH_CLASS, TR_CLASS } from '@/app/components/ListToolbar';
import { classifyFetchError } from '@/app/lib/errors';
import RoleEditor, { type RoleSummary } from './RoleEditor';
import { Modal, ModalActions, formatDateTime } from './dialogs';

type View = { kind: 'list' } | { kind: 'create'; from?: RoleSummary } | { kind: 'edit'; role: RoleSummary };

export default function RolesTab({ refreshKey, onShowUsers }: { refreshKey: number; onShowUsers: (roleKey: string) => void }) {
  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestKey = `${refreshKey}:${nonce}`;
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const loading = doneKey !== requestKey;
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [toast, setToast] = useState<ToastState>(null);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/roles?t=${Date.now()}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ? `${res.status} ${data.error}` : `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setError(null);
        setRoles(data.roles);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive && setDoneKey(requestKey));
    return () => {
      alive = false;
    };
  }, [requestKey]);

  // Admin (locked) pinned first, then the rest by Last edited, newest first.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (roles ?? [])
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.locked) - Number(a.locked) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [roles, search]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/roles/${deleting.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data.error || 'Could not delete the role.');
        return;
      }
      setToast({ type: 'success', message: `Role "${deleting.name}" deleted.` });
      setDeleting(null);
      load();
    } finally {
      setDeleteBusy(false);
    }
  };

  if (view.kind !== 'list' && roles) {
    return (
      <RoleEditor
        mode={view}
        roles={roles}
        onCancel={() => setView({ kind: 'list' })}
        onDone={(message) => {
          setView({ kind: 'list' });
          setToast({ type: 'success', message });
          load();
        }}
      />
    );
  }

  if (error && !roles) return <ConnectionErrorState error={classifyFetchError(error)} onRetry={load} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
        <SearchPill value={search} onChange={setSearch} loading={loading && !roles} placeholder="Search roles" />
        <button type="button" onClick={() => setView({ kind: 'create' })} disabled={!roles} className={PRIMARY_TOOLBAR_BUTTON_CLASS}>
          <Plus size={13} />
          Create role
        </button>
      </div>

      <div className={TABLE_WRAPPER_CLASS.replace('flex-1', 'flex-none')}>
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col style={{ width: '28%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '32%' }} />
            <col style={{ width: '26%' }} />
          </colgroup>
          <thead>
            <tr className="h-[38px]">
              <th className={`${TH_CLASS} !pl-6 text-left`}>Role name</th>
              <th className={`${TH_CLASS} text-left`}>Users</th>
              <th className={`${TH_CLASS} text-left`}>Last edited</th>
              <th className={`${TH_CLASS} !pr-6 text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles && rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-muted-foreground">
                  No roles match.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={TR_CLASS}>
                  <td className={`${TD_CLASS} !pl-6 truncate text-left font-medium text-foreground`}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.name}
                      {r.locked && <Lock size={11} className="text-muted-foreground" aria-label="Locked" />}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-left`}>
                    {r.userCount > 0 ? (
                      <button type="button" onClick={() => onShowUsers(r.key)} className="font-medium text-[var(--ui-accent)] hover:underline">
                        {r.userCount}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className={`${TD_CLASS} truncate text-left text-foreground`}>
                    {formatDateTime(r.updatedAt)}
                    {/* Seeded/default roles were never edited by a person. */}
                    <span className="text-muted-foreground"> · {r.updatedByName ?? 'System'}</span>
                  </td>
                  <td className={`${TD_CLASS} !pr-6 whitespace-nowrap text-right`}>
                    {/* Fixed-width slots (Edit | Duplicate | Delete) so the
                        buttons line up on every row; Admin's Delete slot
                        stays empty but keeps its width. */}
                    <div className="inline-flex items-center justify-end">
                      <span className={`${ACTION_SLOT_CLASS} w-[48px]`}>
                        <RowButton onClick={() => setView({ kind: 'edit', role: r })}>{r.locked ? 'View' : 'Edit'}</RowButton>
                      </span>
                      <span className={`${ACTION_SLOT_CLASS} w-[76px]`}>
                        <RowButton onClick={() => setView({ kind: 'create', from: r })}>Duplicate</RowButton>
                      </span>
                      <span
                        className={`${ACTION_SLOT_CLASS} w-[56px]`}
                        title={!r.locked && r.userCount > 0 ? 'Reassign users before deleting this role.' : undefined}
                      >
                        {!r.locked && (
                          <RowButton
                            danger
                            disabled={r.userCount > 0}
                            onClick={() => {
                              setDeleteError(null);
                              setDeleting(r);
                            }}
                          >
                            Delete
                          </RowButton>
                        )}
                      </span>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {deleting && (
        // Only reachable for roles with 0 users (Delete is disabled otherwise;
        // the server also refuses with 409 if users were added meanwhile).
        <Modal title="Delete role" onClose={() => setDeleting(null)} busy={deleteBusy}>
          <p className="text-[12.5px] text-foreground">
            Delete the <span className="font-semibold">{deleting.name}</span> role? No users have it. This is recorded in the audit log.
          </p>
          {deleteError && <p className="mt-2 text-[12px] font-medium text-rose-600 dark:text-rose-400">{deleteError}</p>}
          <ModalActions onCancel={() => setDeleting(null)} onConfirm={confirmDelete} confirmLabel="Delete role" busy={deleteBusy} destructive />
        </Modal>
      )}
    </div>
  );
}

const ACTION_SLOT_CLASS = 'inline-flex shrink-0 justify-center';

// `danger`: muted like the others, red only on hover.
function RowButton({ children, onClick, danger, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
        danger ? 'hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400' : 'hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}
