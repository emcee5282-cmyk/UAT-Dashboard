// Turns the permission catalog (app/lib/auth/permissions.ts) into what the
// role editor shows: one level per page (none / view / edit), action
// checkboxes, ticket checkboxes — and back into a flat permission list.
import {
  ACTION_LABELS,
  ACTION_NEEDS_EDIT,
  PAGES,
  PAGE_IDS,
  TICKET_TITLES,
  TICKET_TYPES,
  actionPerm,
  editPerm,
  ticketSettlePerm,
  ticketViewPerm,
  viewPerm,
  type PageAction,
  type PageId,
  type Permission,
  type TicketTitle,
} from '@/app/lib/auth/permissions';

export type Level = 'none' | 'view' | 'edit';

export type MatrixState = {
  levels: Record<PageId, Level>;
  actions: Record<PageId, Partial<Record<PageAction, boolean>>>;
  tickets: Record<TicketTitle, { view: boolean; settle: boolean }>;
  raise: boolean;
};

export function emptyMatrix(): MatrixState {
  return {
    levels: Object.fromEntries(PAGE_IDS.map((id) => [id, 'none'])) as MatrixState['levels'],
    actions: Object.fromEntries(PAGE_IDS.map((id) => [id, {}])) as MatrixState['actions'],
    tickets: Object.fromEntries(TICKET_TITLES.map((t) => [t, { view: false, settle: false }])) as MatrixState['tickets'],
    raise: false,
  };
}

export function matrixFromPermissions(perms: readonly string[]): MatrixState {
  const has = (p: string) => perms.includes(p);
  const m = emptyMatrix();
  for (const id of PAGE_IDS) {
    m.levels[id] = PAGES[id].editable && has(editPerm(id)) ? 'edit' : has(viewPerm(id)) ? 'view' : 'none';
    for (const a of PAGES[id].actions as PageAction[]) m.actions[id][a] = has(actionPerm(id, a));
  }
  for (const t of TICKET_TITLES) m.tickets[t] = { view: has(ticketViewPerm(t)) || has(ticketSettlePerm(t)), settle: has(ticketSettlePerm(t)) };
  m.raise = has('tickets.raise');
  return m;
}

// An action only counts when the page level allows it (Delete/Bulk edit
// need Edit; Upload/Telegram need View) — unticking a page's level clears
// its actions on save, so a role never holds an action for a page it can't open.
export function actionAllowed(level: Level, action: PageAction): boolean {
  return ACTION_NEEDS_EDIT[action] ? level === 'edit' : level !== 'none';
}

export function permissionsFromMatrix(m: MatrixState): Permission[] {
  const out: Permission[] = [];
  for (const id of PAGE_IDS) {
    const level = m.levels[id];
    if (level === 'none') continue;
    out.push(viewPerm(id));
    if (level === 'edit') out.push(editPerm(id));
    for (const a of PAGES[id].actions as PageAction[]) if (m.actions[id][a] && actionAllowed(level, a)) out.push(actionPerm(id, a));
  }
  for (const t of TICKET_TITLES) {
    if (m.tickets[t].view || m.tickets[t].settle) out.push(ticketViewPerm(t));
    if (m.tickets[t].settle) out.push(ticketSettlePerm(t));
  }
  if (m.raise) out.push('tickets.raise');
  return out.sort();
}

export function describePermission(p: string): string {
  const parts = p.split('.');
  if (parts[0] === 'page' && parts[1] in PAGES) {
    const page = PAGES[parts[1] as PageId].label;
    if (parts[2] === 'view') return `${page}: View`;
    if (parts[2] === 'edit') return `${page}: Edit`;
    return `${page}: ${ACTION_LABELS[parts[2] as PageAction] ?? parts[2]}`;
  }
  if (p === 'tickets.raise') return 'Tickets: Raise (own only)';
  if (parts[0] === 'tickets' && parts[1] in TICKET_TYPES) {
    return `Tickets · ${TICKET_TYPES[parts[1] as TicketTitle]}: ${parts[2] === 'settle' ? 'Settle' : 'View'}`;
  }
  return p;
}

export function diffPermissions(before: readonly string[], after: readonly string[]) {
  return {
    added: after.filter((p) => !before.includes(p)).map(describePermission),
    removed: before.filter((p) => !after.includes(p)).map(describePermission),
  };
}

// One-line access summary for the Roles table / role tabs.
export function accessSummary(perms: readonly string[]): string {
  const pages = PAGE_IDS.filter((id) => perms.includes(viewPerm(id)));
  const edits = PAGE_IDS.filter((id) => perms.includes(editPerm(id)));
  const settles = TICKET_TITLES.filter((t) => perms.includes(ticketSettlePerm(t)));
  const bits: string[] = [];
  if (pages.length) bits.push(`${pages.length} page${pages.length === 1 ? '' : 's'}${edits.length ? ` (${edits.length} editable)` : ''}`);
  if (settles.length) bits.push(`settles ${settles.length} ticket type${settles.length === 1 ? '' : 's'}`);
  if (perms.includes('tickets.raise')) bits.push('raises tickets');
  return bits.join(' · ') || 'No access';
}
