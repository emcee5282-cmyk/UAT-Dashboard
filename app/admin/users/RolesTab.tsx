'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import Toast, { type ToastState } from '@/app/components/Toast';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import { PRIMARY_TOOLBAR_BUTTON_CLASS, SearchPill, TABLE_WRAPPER_CLASS, TD_CLASS, TH_CLASS, TR_CLASS } from '@/app/components/ListToolbar';
import { classifyFetchError } from '@/app/lib/errors';
import RoleEditor, { type RoleSummary } from './RoleEditor';
import { accessSummary } from './roleMatrix';
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

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (roles ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
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

      <div className={TABLE_WRAPPER_CLASS}>
        {loading && <TableLoadingSpinner overlay />}
        <table className="w-full min-w-[860px] table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col style={{ width: '15%' }} />
            <col style={{ width: '33%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr className="h-[38px]">
              <th className={`${TH_CLASS} text-left`}>Role name</th>
              <th className={`${TH_CLASS} text-left`}>Description</th>
              <th className={`${TH_CLASS} text-right`}>Users</th>
              <th className={`${TH_CLASS} text-left`}>Last edited</th>
              <th className={`${TH_CLASS} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles && rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                  No roles match.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={TR_CLASS}>
                  <td className={`${TD_CLASS} truncate font-medium text-foreground`}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.name}
                      {r.locked && <Lock size={11} className="text-muted-foreground" aria-label="Locked" />}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <p className="truncate text-foreground">{r.description || '−'}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">{r.locked ? 'Full access (locked)' : accessSummary(r.permissions)}</p>
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {r.userCount > 0 ? (
                      <button type="button" onClick={() => onShowUsers(r.key)} className="font-medium text-[var(--ui-accent)] hover:underline">
                        {r.userCount}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className={`${TD_CLASS} truncate text-foreground`}>
                    {formatDateTime(r.updatedAt)}
                    {r.updatedByName && <span className="text-muted-foreground"> · {r.updatedByName}</span>}
                  </td>
                  <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                    <div className="inline-flex items-center gap-0.5">
                      <RowButton onClick={() => setView({ kind: 'edit', role: r })}>{r.locked ? 'View' : 'Edit'}</RowButton>
                      <RowButton onClick={() => setView({ kind: 'create', from: r })}>Duplicate</RowButton>
                      {!r.locked && (
                        <RowButton
                          danger
                          onClick={() => {
                            setDeleteError(null);
                            setDeleting(r);
                          }}
                        >
                          Delete
                        </RowButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {deleting && (
        <Modal title="Delete role" onClose={() => setDeleting(null)} busy={deleteBusy}>
          {deleting.userCount > 0 ? (
            <>
              <p className="text-[12.5px] text-foreground">
                <span className="font-semibold">{deleting.name}</span> still has {deleting.userCount} user{deleting.userCount === 1 ? '' : 's'}. Move them to another role
                first (Users tab → Edit → Role), then delete it.
              </p>
              <ModalActions
                onCancel={() => setDeleting(null)}
                onConfirm={() => {
                  onShowUsers(deleting.key);
                  setDeleting(null);
                }}
                confirmLabel="Show these users"
              />
            </>
          ) : (
            <>
              <p className="text-[12.5px] text-foreground">
                Delete the <span className="font-semibold">{deleting.name}</span> role? No users have it. This is recorded in the audit log.
              </p>
              {deleteError && <p className="mt-2 text-[12px] font-medium text-rose-600 dark:text-rose-400">{deleteError}</p>}
              <ModalActions onCancel={() => setDeleting(null)} onConfirm={confirmDelete} confirmLabel="Delete role" busy={deleteBusy} destructive />
            </>
          )}
        </Modal>
      )}
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
