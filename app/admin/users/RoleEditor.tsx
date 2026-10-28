'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react';
import { PRIMARY_TOOLBAR_BUTTON_CLASS, EXPORT_BUTTON_CLASS } from '@/app/components/ListToolbar';
import { ACTION_LABELS, ADMIN_ONLY, PAGES, SECTIONS, TICKET_TITLES, TICKET_TYPES, type PageAction, type PageId } from '@/app/lib/auth/permissions';
import { actionAllowed, diffPermissions, emptyMatrix, matrixFromPermissions, permissionsFromMatrix, type Level, type MatrixState } from './roleMatrix';
import { FormField, Modal, ModalActions, inputClass } from './dialogs';

export type RoleSummary = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  locked: boolean;
  userCount: number;
  permissions: string[];
  updatedAt: string;
  updatedByName: string | null;
};

type Mode = { kind: 'create'; from?: RoleSummary } | { kind: 'edit'; role: RoleSummary };

const LEVEL_LABEL: Record<Level, string> = { none: 'No access', view: 'View', edit: 'Edit' };

export default function RoleEditor({ mode, roles, onDone, onCancel }: { mode: Mode; roles: RoleSummary[]; onDone: (message: string) => void; onCancel: () => void }) {
  const editingRole = mode.kind === 'edit' ? mode.role : null;
  const locked = !!editingRole?.locked;
  const startPerms = mode.kind === 'edit' ? mode.role.permissions : (mode.from?.permissions ?? []);

  const [name, setName] = useState(mode.kind === 'edit' ? mode.role.name : mode.from ? `Copy of ${mode.from.name}` : '');
  const [description, setDescription] = useState(mode.kind === 'edit' ? (mode.role.description ?? '') : (mode.from?.description ?? ''));
  const [copyFrom, setCopyFrom] = useState<string>(mode.kind === 'create' && mode.from ? String(mode.from.id) : '');
  const [matrix, setMatrix] = useState<MatrixState>(() => matrixFromPermissions(startPerms));
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const permissions = useMemo(() => permissionsFromMatrix(matrix), [matrix]);
  const baseline = mode.kind === 'edit' ? permissionsFromMatrix(matrixFromPermissions(mode.role.permissions)) : [];
  const diff = diffPermissions(baseline, permissions);

  const setLevel = (id: PageId, level: Level) => setMatrix((m) => ({ ...m, levels: { ...m.levels, [id]: level } }));
  const setAction = (id: PageId, a: PageAction, on: boolean) => setMatrix((m) => ({ ...m, actions: { ...m.actions, [id]: { ...m.actions[id], [a]: on } } }));

  const setSection = (pages: PageId[], on: boolean) =>
    setMatrix((m) => {
      const next = { ...m, levels: { ...m.levels }, actions: { ...m.actions } };
      for (const id of pages) {
        next.levels[id] = on ? (PAGES[id].editable ? 'edit' : 'view') : 'none';
        next.actions[id] = Object.fromEntries((PAGES[id].actions as PageAction[]).map((a) => [a, on]));
      }
      return next;
    });
  const setAllTickets = (on: boolean) =>
    setMatrix((m) => ({ ...m, tickets: Object.fromEntries(TICKET_TITLES.map((t) => [t, { view: on, settle: on }])) as MatrixState['tickets'], raise: on }));

  const applyCopyFrom = (id: string) => {
    setCopyFrom(id);
    const src = roles.find((r) => String(r.id) === id);
    setMatrix(src ? matrixFromPermissions(src.permissions) : emptyMatrix());
  };

  const nameChanged = mode.kind === 'edit' && name.trim() !== mode.role.name;
  const descChanged = mode.kind === 'edit' && (description.trim() || null) !== (mode.role.description || null);
  const nothingChanged = mode.kind === 'edit' && !nameChanged && !descChanged && diff.added.length === 0 && diff.removed.length === 0;

  const openReview = () => {
    if (name.trim().length < 2) {
      setError({ field: 'name', message: 'Give the role a name (2-40 characters).' });
      return;
    }
    setError(null);
    setReviewOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(mode.kind === 'edit' ? `/api/admin/roles/${mode.role.id}` : '/api/admin/roles', {
        method: mode.kind === 'edit' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, permissions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReviewOpen(false);
        setError({ field: data.field, message: data.error || 'Could not save the role.' });
        return;
      }
      onDone(mode.kind === 'edit' ? `Role "${name.trim()}" saved. Changes apply on each user's next click.` : `Role "${name.trim()}" created.`);
    } finally {
      setSaving(false);
    }
  };

  const title = locked ? editingRole!.name : mode.kind === 'edit' ? `Edit role: ${mode.role.name}` : 'Create role';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
        <button type="button" onClick={onCancel} className="flex h-8 items-center gap-1.5 text-[13.5px] font-semibold text-foreground hover:text-[var(--ui-accent)]">
          <ArrowLeft size={15} />
          {title}
        </button>
        {!locked && (
          <div className="flex items-center gap-[10px]">
            <button type="button" onClick={onCancel} className={EXPORT_BUTTON_CLASS + ' !w-auto !px-[10px]'}>
              Cancel
            </button>
            <button type="button" onClick={openReview} disabled={nothingChanged} className={PRIMARY_TOOLBAR_BUTTON_CLASS}>
              {mode.kind === 'edit' ? 'Review & save' : 'Review & create'}
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {locked && (
          <div className="mb-4 flex items-start gap-2 rounded-[10px] border border-[#C7D2FE] bg-[#EEF2FF] px-4 py-3 text-[12px] text-[#3730A3] dark:border-[#3A3F6B] dark:bg-[#1E2140] dark:text-[#C7D2FE]">
            <Lock size={14} className="mt-px shrink-0" />
            The Admin role is locked: it always has full access and can&apos;t be edited, renamed or deleted, so nobody can lock themselves out.
          </div>
        )}

        {error && !error.field && <p className="mb-3 text-[12px] font-medium text-rose-600 dark:text-rose-400">{error.message}</p>}

        <div className="mb-5 grid gap-4 rounded-[10px] border border-[#DEE1E8] bg-white p-4 md:grid-cols-3 dark:border-[#262B38] dark:bg-[#12151D]">
          <FormField label="Role name" error={error?.field === 'name' ? error.message : undefined}>
            <input value={name} disabled={locked} maxLength={40} onChange={(e) => setName(e.target.value)} className={`${inputClass} disabled:opacity-60`} />
          </FormField>
          <FormField label="Description" hint="Optional — shown on the Roles list.">
            <input value={description} disabled={locked} maxLength={200} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} disabled:opacity-60`} />
          </FormField>
          {mode.kind === 'create' && (
            <FormField label="Copy access from" hint="Optional starting point — you can change anything after.">
              <select value={copyFrom} onChange={(e) => applyCopyFrom(e.target.value)} className={inputClass}>
                <option value="">Start from no access</option>
                {roles
                  .filter((r) => !r.locked)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </FormField>
          )}
        </div>

        <div className="space-y-4">
          {SECTIONS.map((section) => (
            <MatrixSection
              key={section.id}
              label={section.label}
              locked={locked}
              onSelectAll={() => setSection(section.pages, true)}
              onClearAll={() => setSection(section.pages, false)}
            >
              {section.pages.map((id) => {
                const page = PAGES[id];
                const level = locked ? (page.editable ? 'edit' : 'view') : matrix.levels[id];
                const levels: Level[] = page.editable ? ['none', 'view', 'edit'] : ['none', 'view'];
                return (
                  <div key={id} className="border-b border-[#ECEFF3] px-5 py-2.5 last:border-0 dark:border-[#1A1E29]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-medium text-foreground">{page.label}</p>
                        <p className="text-[10.5px] text-muted-foreground">{page.paths.map((p) => p.path).join('  ·  ')}</p>
                      </div>
                      <div role="radiogroup" aria-label={`${page.label} access`} className="flex items-center gap-4">
                        {levels.map((l) => (
                          <label key={l} className={`flex items-center gap-1.5 text-[12px] ${locked ? 'opacity-70' : 'cursor-pointer'}`}>
                            <input type="radio" name={`lvl-${id}`} checked={level === l} disabled={locked} onChange={() => setLevel(id, l)} className="accent-[var(--ui-accent)]" />
                            {LEVEL_LABEL[l]}
                          </label>
                        ))}
                      </div>
                    </div>
                    {(page.actions as PageAction[]).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 pl-3">
                        {(page.actions as PageAction[]).map((a) => {
                          const allowed = actionAllowed(level, a);
                          const checked = locked || (allowed && !!matrix.actions[id][a]);
                          return (
                            <label
                              key={a}
                              title={allowed ? undefined : a === 'delete' || a === 'bulkEdit' ? 'Needs Edit access' : 'Needs View access'}
                              className={`flex items-center gap-1.5 text-[11.5px] ${allowed && !locked ? 'cursor-pointer text-foreground' : 'text-muted-foreground opacity-60'}`}
                            >
                              <input type="checkbox" checked={checked} disabled={!allowed || locked} onChange={(e) => setAction(id, a, e.target.checked)} className="accent-[var(--ui-accent)]" />
                              {ACTION_LABELS[a]}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </MatrixSection>
          ))}

          <MatrixSection label="Support" locked={locked} onSelectAll={() => setAllTickets(true)} onClearAll={() => setAllTickets(false)}>
            <div className="border-b border-[#ECEFF3] px-5 py-2 dark:border-[#1A1E29]">
              <p className="text-[12.5px] font-medium text-foreground">Tickets</p>
              <p className="text-[10.5px] text-muted-foreground">/staff/tickets — each type is shown only to roles that can view or settle it</p>
            </div>
            {TICKET_TITLES.map((t) => {
              const v = locked || matrix.tickets[t].view || matrix.tickets[t].settle;
              const s = locked || matrix.tickets[t].settle;
              return (
                <div key={t} className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEFF3] px-5 py-2 pl-8 dark:border-[#1A1E29]">
                  <p className="text-[12px] text-foreground">{TICKET_TYPES[t]}</p>
                  <div className="flex items-center gap-5">
                    <label className={`flex items-center gap-1.5 text-[11.5px] ${locked || matrix.tickets[t].settle ? 'text-muted-foreground' : 'cursor-pointer text-foreground'}`}>
                      <input
                        type="checkbox"
                        checked={v}
                        disabled={locked || matrix.tickets[t].settle}
                        title={matrix.tickets[t].settle ? 'Settle includes View' : undefined}
                        onChange={(e) => setMatrix((m) => ({ ...m, tickets: { ...m.tickets, [t]: { ...m.tickets[t], view: e.target.checked } } }))}
                        className="accent-[var(--ui-accent)]"
                      />
                      View
                    </label>
                    <label className={`flex items-center gap-1.5 text-[11.5px] ${locked ? 'text-muted-foreground' : 'cursor-pointer text-foreground'}`}>
                      <input
                        type="checkbox"
                        checked={s}
                        disabled={locked}
                        onChange={(e) => setMatrix((m) => ({ ...m, tickets: { ...m.tickets, [t]: { view: m.tickets[t].view || e.target.checked, settle: e.target.checked } } }))}
                        className="accent-[var(--ui-accent)]"
                      />
                      Settle
                    </label>
                  </div>
                </div>
              );
            })}
            <label className={`flex items-center gap-2 px-5 py-2.5 text-[12px] ${locked ? 'text-muted-foreground' : 'cursor-pointer text-foreground'}`}>
              <input type="checkbox" checked={locked ? false : matrix.raise} disabled={locked} onChange={(e) => setMatrix((m) => ({ ...m, raise: e.target.checked }))} className="accent-[var(--ui-accent)]" />
              Raise tickets (own only, leader-linked)
              <span className="text-[10.5px] text-muted-foreground">— users with this role must be linked to a leader name</span>
            </label>
          </MatrixSection>

          <MatrixSection label="Settings" locked>
            {Object.entries(ADMIN_ONLY).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-3 border-b border-[#ECEFF3] px-5 py-2 last:border-0 dark:border-[#1A1E29]">
                <p className="text-[12px] text-foreground">{label}</p>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  <ShieldCheck size={12} />
                  Admin only
                </span>
              </div>
            ))}
          </MatrixSection>
        </div>
      </div>

      {reviewOpen && (
        <Modal title={mode.kind === 'edit' ? 'Save changes?' : 'Create role?'} icon={ShieldCheck} onClose={() => setReviewOpen(false)} busy={saving} wide>
          <div className="max-h-[50vh] space-y-3 overflow-auto text-[12px]">
            {mode.kind === 'edit' ? (
              <>
                {nameChanged && <ChangeLine label="Name" text={`${mode.role.name} → ${name.trim()}`} />}
                {descChanged && <ChangeLine label="Description" text={`${mode.role.description || '(none)'} → ${description.trim() || '(none)'}`} />}
                <ChangeList title="Access added" tone="add" items={diff.added} />
                <ChangeList title="Access removed" tone="remove" items={diff.removed} />
                {mode.role.userCount > 0 && (
                  <p className="text-muted-foreground">
                    Applies to {mode.role.userCount} user{mode.role.userCount === 1 ? '' : 's'} on their next click.
                  </p>
                )}
              </>
            ) : (
              <>
                <ChangeLine label="Name" text={name.trim()} />
                <ChangeList title="Access granted" tone="add" items={diffPermissions([], permissions).added} empty="No access (the role can log in but sees nothing)." />
              </>
            )}
          </div>
          <ModalActions onCancel={() => setReviewOpen(false)} onConfirm={save} confirmLabel={mode.kind === 'edit' ? 'Save role' : 'Create role'} busy={saving} />
        </Modal>
      )}
    </div>
  );
}

function MatrixSection({
  label,
  locked,
  onSelectAll,
  onClearAll,
  children,
}: {
  label: string;
  locked?: boolean;
  onSelectAll?: () => void;
  onClearAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-[#DEE1E8] bg-white dark:border-[#262B38] dark:bg-[#12151D]">
      <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#FAFBFC] px-5 py-2 dark:border-[#262B38] dark:bg-[#0E1119]">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">{label}</h3>
        {!locked && onSelectAll && (
          <div className="flex items-center gap-3 text-[11px] font-medium">
            <button type="button" onClick={onSelectAll} className="text-[var(--ui-accent)] hover:underline">
              Select all
            </button>
            <button type="button" onClick={onClearAll} className="text-muted-foreground hover:text-foreground hover:underline">
              Clear all
            </button>
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

function ChangeLine({ label, text }: { label: string; text: string }) {
  return (
    <p>
      <span className="font-semibold text-foreground">{label}:</span> <span className="text-foreground">{text}</span>
    </p>
  );
}

function ChangeList({ title, items, tone, empty }: { title: string; items: string[]; tone: 'add' | 'remove'; empty?: string }) {
  if (items.length === 0 && !empty) return null;
  return (
    <div>
      <p className="mb-1 font-semibold text-foreground">
        {title} {items.length > 0 && <span className="font-normal text-muted-foreground">({items.length})</span>}
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <li key={i} className={tone === 'add' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
              {tone === 'add' ? '+ ' : '− '}
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
