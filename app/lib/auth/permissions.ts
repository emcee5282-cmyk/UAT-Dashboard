// THE CATALOG of everything that can be granted — pages, their actions,
// ticket rights — and which of those each page/API route requires. WHO gets
// what lives in the database (roles + role_permissions, edited on Users →
// Roles); this file never lists a role's access.
//
// Read by proxy.ts (pages + API), by every API handler (guard.ts), and by
// the UI (Sidebar, useCan, the role editor's permission matrix). Pure data +
// pure functions only (no DB, no Node APIs) so client code can import it.
//
// Adding a page later: add it to PAGES (+ its routes to API_RULES). Until a
// role is explicitly given access on the Roles screen, only Admin can open
// it — unlisted pages fall through to DEFAULT_PAGE_RULE (admin-only).

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type PageAction = 'upload' | 'telegram' | 'delete' | 'bulkEdit';
export const ACTION_LABELS: Record<PageAction, string> = {
  upload: 'Upload / Import',
  telegram: 'Send to Telegram',
  delete: 'Delete',
  bulkEdit: 'Bulk edit',
};
// Delete / Bulk edit only make sense on top of Edit; Upload / Telegram only need View.
export const ACTION_NEEDS_EDIT: Record<PageAction, boolean> = { upload: false, telegram: false, delete: true, bulkEdit: true };

type PageDef = {
  label: string;
  // Every route this one permission row covers (Cashout + its Send Money
  // counterpart share one row — same screen, other product).
  paths: { path: string; exact?: boolean }[];
  editable: boolean; // offers View / Edit, or View only
  actions: PageAction[];
};

export const PAGES = {
  dashboard: { label: 'Dashboard', paths: [{ path: '/', exact: true }], editable: false, actions: ['telegram'] },
  balance: { label: 'Balance', paths: [{ path: '/agentbal' }, { path: '/sendmoney/balances' }], editable: false, actions: ['upload'] },
  opening: { label: 'Opening', paths: [{ path: '/summary' }, { path: '/sendmoney/opening' }], editable: true, actions: ['upload', 'delete', 'bulkEdit'] },
  settlement: { label: 'Settlement', paths: [{ path: '/stlm' }, { path: '/sendmoney/settlement' }], editable: true, actions: ['upload', 'delete', 'bulkEdit'] },
  topup: { label: 'Top Up', paths: [{ path: '/topup' }, { path: '/sendmoney/topup' }], editable: true, actions: ['upload', 'delete', 'bulkEdit'] },
  dailyEntry: { label: 'Daily Entry', paths: [{ path: '/daily-txn-entry' }], editable: true, actions: [] },
  transferQueue: { label: 'Transfer Queue', paths: [{ path: '/transfer-queue' }, { path: '/sendmoney/transfer-queue' }], editable: false, actions: [] },
  walletStatus: { label: 'Wallet Status', paths: [{ path: '/wallet-status' }, { path: '/sendmoney/wallet-status' }], editable: true, actions: ['bulkEdit'] },
  pendingBalance: { label: 'Pending Balance', paths: [{ path: '/monitoring/pending-balance' }], editable: false, actions: ['telegram'] },
} satisfies Record<string, PageDef>;
export type PageId = keyof typeof PAGES;
export const PAGE_IDS = Object.keys(PAGES) as PageId[];

export const TICKET_TYPES = {
  agent_concern: 'Agent concern',
  shop_replacement: 'Shop replacement',
  adding_new_account: 'Adding new account',
} as const;
export type TicketTitle = keyof typeof TICKET_TYPES;
export const TICKET_TITLES = Object.keys(TICKET_TYPES) as TicketTitle[];

// Grouped exactly like the sidebar.
export const SECTIONS: { id: string; label: string; pages: PageId[] }[] = [
  { id: 'overview', label: 'Overview', pages: ['dashboard'] },
  { id: 'operations', label: 'Operations', pages: ['balance', 'opening', 'settlement', 'topup', 'dailyEntry'] },
  { id: 'monitoring', label: 'Monitoring', pages: ['transferQueue', 'walletStatus', 'pendingBalance'] },
];

// Never grantable from the Roles screen — Admin only, always. Shown in the
// matrix's Settings section as fixed "Admin only" rows.
export const ADMIN_ONLY = {
  'settings.manage': 'Settings',
  'users.manage': 'Users',
  'roles.manage': 'Roles & permissions',
  'tickets.leaderView': 'Open the leader ticket pages (support view)',
  'sandbox.view': 'Demo / sandbox pages',
} as const;
type AdminOnlyPermission = keyof typeof ADMIN_ONLY;

export type Permission =
  | `page.${PageId}.view`
  | `page.${PageId}.edit`
  | `page.${PageId}.${PageAction}`
  | `tickets.${TicketTitle}.view`
  | `tickets.${TicketTitle}.settle`
  | 'tickets.raise'
  | AdminOnlyPermission
  | 'system.sync';

export const viewPerm = (id: PageId) => `page.${id}.view` as const;
export const editPerm = (id: PageId) => `page.${id}.edit` as const;
export const actionPerm = (id: PageId, a: PageAction) => `page.${id}.${a}` as const;
export const ticketViewPerm = (t: TicketTitle) => `tickets.${t}.view` as const;
export const ticketSettlePerm = (t: TicketTitle) => `tickets.${t}.settle` as const;

// Everything a non-Admin role may be given on the Roles screen.
export const GRANTABLE_PERMISSIONS: Permission[] = [
  ...PAGE_IDS.flatMap((id) => {
    const p = PAGES[id] as PageDef;
    return [viewPerm(id), ...(p.editable ? [editPerm(id)] : []), ...p.actions.map((a) => actionPerm(id, a))];
  }),
  ...TICKET_TITLES.flatMap((t) => [ticketViewPerm(t), ticketSettlePerm(t)]),
  'tickets.raise',
];
const GRANTABLE = new Set<string>(GRANTABLE_PERMISSIONS);
export const ALL_PERMISSIONS: Permission[] = [...GRANTABLE_PERMISSIONS, ...(Object.keys(ADMIN_ONLY) as AdminOnlyPermission[]), 'system.sync'];

export function isGrantable(p: string): p is Permission {
  return GRANTABLE.has(p);
}

// ---------------------------------------------------------------------------
// Fixed roles (rows in `roles`, but with behavior pinned in code)
// ---------------------------------------------------------------------------

// Locked: always full access regardless of what role_permissions holds —
// cannot be edited, renamed or deleted, so nobody can lock themselves out.
export const ADMIN_ROLE = 'admin';
// The scheduler's service-account role — hidden from Users/Roles, never
// editable there, and its only possible permission is system.sync.
export const SYSTEM_ROLE = 'system';
// Legacy users.role values mapped to a real role key instead of rewriting rows.
export const ROLE_ALIASES: Record<string, string> = { staff: 'ops' };

export function normalizeRoleKey(raw: string | null | undefined): string {
  const v = (raw ?? '').toLowerCase();
  return ROLE_ALIASES[v] ?? v;
}

// What a role can actually do, given what the database stores for it.
// Unknown/stale keys in the DB are dropped, admin-only keys can't be
// smuggled in through role_permissions, and edit implies view.
// Admin gets everything except raising tickets — that's the leader-linked
// flow (scoped to one leader's own shops); Admin works the staff queue and
// can look at the leader pages via tickets.leaderView instead.
const ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => p !== 'tickets.raise');

export function effectivePermissions(roleKey: string, stored: readonly string[]): Permission[] {
  if (roleKey === ADMIN_ROLE) return ADMIN_PERMISSIONS;
  if (roleKey === SYSTEM_ROLE) return stored.includes('system.sync') ? ['system.sync'] : [];
  const set = new Set(stored.filter(isGrantable));
  for (const id of PAGE_IDS) if (set.has(editPerm(id))) set.add(viewPerm(id));
  for (const t of TICKET_TITLES) if (set.has(ticketSettlePerm(t))) set.add(ticketViewPerm(t));
  return [...set] as Permission[];
}

// ---------------------------------------------------------------------------
// Checks — all take the user's effective permission list
// ---------------------------------------------------------------------------

type Perms = readonly string[] | null | undefined;

export function can(perms: Perms, permission: Permission): boolean {
  return !!perms?.includes(permission);
}

export function canAny(perms: Perms, permissions: readonly Permission[]): boolean {
  return !!perms && permissions.some((p) => perms.includes(p));
}

export function canViewQueueTicket(perms: Perms, title: string): boolean {
  const t = title as TicketTitle;
  return t in TICKET_TYPES && (can(perms, ticketViewPerm(t)) || can(perms, ticketSettlePerm(t)));
}

export function canSettleTicket(perms: Perms, title: string): boolean {
  const t = title as TicketTitle;
  return t in TICKET_TYPES && can(perms, ticketSettlePerm(t));
}

export function queueTitlesFor(perms: Perms): TicketTitle[] {
  return TICKET_TITLES.filter((t) => canViewQueueTicket(perms, t));
}

// Raising tickets is scoped to one leader's own shops, so it needs the
// account to be linked to a leader name (users.leaderId).
export function needsLeaderLink(perms: Perms): boolean {
  return can(perms, 'tickets.raise');
}

// ---------------------------------------------------------------------------
// Pages. Longest matching prefix wins; ANY listed permission grants access.
// ---------------------------------------------------------------------------

type Rule = { prefix: string; exact?: boolean; anyOf: Permission[] };

const ANY_TICKET_QUEUE: Permission[] = TICKET_TITLES.flatMap((t) => [ticketViewPerm(t), ticketSettlePerm(t)]);
const ANY_TELEGRAM: Permission[] = [actionPerm('dashboard', 'telegram'), actionPerm('pendingBalance', 'telegram')];
const ANY_DATA_VIEW: Permission[] = PAGE_IDS.map(viewPerm);

export const PAGE_RULES: Rule[] = [
  ...PAGE_IDS.flatMap((id) => (PAGES[id] as PageDef).paths.map((p) => ({ prefix: p.path, exact: p.exact, anyOf: [viewPerm(id)] }))),
  { prefix: '/staff/tickets', anyOf: ANY_TICKET_QUEUE },
  { prefix: '/tickets/create', anyOf: ['tickets.raise'] },
  { prefix: '/tickets', anyOf: ['tickets.raise', 'tickets.leaderView'] },
  // Puppeteer render targets for TG sends — opened server-side with the
  // sender's own forwarded session cookie.
  { prefix: '/internal', anyOf: ANY_TELEGRAM },
  { prefix: '/settings', anyOf: ['settings.manage'] },
  { prefix: '/admin/users', anyOf: ['users.manage'] },
  { prefix: '/dashboard-demo', anyOf: ['sandbox.view'] },
  { prefix: '/shadcn-demo', anyOf: ['sandbox.view'] },
  { prefix: '/mockup', anyOf: ['sandbox.view'] },
  { prefix: '/wallet-status-demo', anyOf: ['sandbox.view'] },
  { prefix: '/ticket-settlement', anyOf: ['sandbox.view'] },
];
const DEFAULT_PAGE_RULE: Permission[] = ['sandbox.view']; // admin-only

// Pages any signed-in user may open, even while a password change is pending.
export const ACCOUNT_PAGES = ['/change-password', '/no-access'];
export const PUBLIC_PAGES = ['/login'];

// ---------------------------------------------------------------------------
// API routes — same matching, split by method: read (GET/HEAD), write
// (POST/PUT/PATCH), del (DELETE, defaults to write). Unlisted: reads need
// any data-page view, writes are admin-only.
// ---------------------------------------------------------------------------

type ApiRule = { prefix: string; read: Permission[]; write?: Permission[]; del?: Permission[] };
const v = viewPerm;
const e = editPerm;
const act = actionPerm;

function recordPage(prefix: string, id: 'opening' | 'settlement' | 'topup', alsoReadBy: PageId[] = []): ApiRule {
  return { prefix, read: [v(id), ...alsoReadBy.map(v)], write: [e(id)], del: [act(id, 'delete')] };
}
const QUEUE_READERS: Permission[] = [v('transferQueue'), v('balance'), v('walletStatus'), v('dashboard')];

export const API_RULES: ApiRule[] = [
  // Record pages. Bulk edit (PATCH with several ids) is additionally
  // checked inside the handler — see requireBulkEdit in guard.ts.
  recordPage('/api/v2/opening', 'opening', ['settlement', 'topup', 'walletStatus']),
  recordPage('/api/v2/sendmoney/opening', 'opening', ['settlement', 'topup', 'walletStatus']),
  recordPage('/api/v2/settlement', 'settlement'),
  recordPage('/api/v2/sendmoney/settlement', 'settlement'),
  recordPage('/api/v2/topup', 'topup'),
  recordPage('/api/v2/sendmoney/topup', 'topup'),
  { prefix: '/api/v2/brands', read: [v('settlement'), v('topup')] },
  { prefix: '/api/opening', read: [v('opening'), v('balance'), v('transferQueue')] },
  { prefix: '/api/sendmoney/opening', read: [v('opening'), v('balance')] },
  { prefix: '/api/opening/estimated-balance', read: [v('balance')] },
  { prefix: '/api/sendmoney/opening/estimated-balance', read: [v('balance')] },
  // Uploads / imports
  { prefix: '/api/opening/upload-estimated-balance', read: [act('opening', 'upload')], write: [act('opening', 'upload')] },
  { prefix: '/api/sendmoney/opening/upload-estimated-balance', read: [act('opening', 'upload')], write: [act('opening', 'upload')] },
  { prefix: '/api/v2/import/opening', read: [act('opening', 'upload')], write: [act('opening', 'upload')] },
  { prefix: '/api/v2/import/settlement', read: [act('settlement', 'upload')], write: [act('settlement', 'upload')] },
  { prefix: '/api/v2/import/topup', read: [act('topup', 'upload')], write: [act('topup', 'upload')] },
  { prefix: '/api/v2/import/balance-limit', read: [act('balance', 'upload')], write: [act('balance', 'upload')] },
  {
    prefix: '/api/v2/import/existing-records',
    read: [act('opening', 'upload'), act('settlement', 'upload'), act('topup', 'upload'), act('balance', 'upload')],
    write: [act('opening', 'upload'), act('settlement', 'upload'), act('topup', 'upload'), act('balance', 'upload')],
  },
  // Balance / Transfer Queue reads (shared helpers also feed the sidebar badge)
  { prefix: '/api/v2/agentbal', read: [v('balance')] },
  { prefix: '/api/v2/stlmtopup', read: [v('balance')] },
  { prefix: '/api/v2/sendmoney/balances', read: [v('balance')] },
  { prefix: '/api/v2/balance-limit', read: [v('balance'), v('walletStatus')] },
  { prefix: '/api/v2/transfer-queue', read: QUEUE_READERS },
  { prefix: '/api/v2/sendmoney/transfer-queue', read: QUEUE_READERS },
  { prefix: '/api/agentbal', read: QUEUE_READERS },
  { prefix: '/api/agstlmtopup', read: QUEUE_READERS },
  { prefix: '/api/sendmoney/balances', read: QUEUE_READERS },
  { prefix: '/api/sendmoney/stlmtopup', read: QUEUE_READERS },
  { prefix: '/api/dashboard', read: [v('dashboard')] },
  // Wallet Status
  { prefix: '/api/wallet-status', read: [v('walletStatus')], write: [e('walletStatus')] },
  { prefix: '/api/sendmoney/wallet-status', read: [v('walletStatus')], write: [e('walletStatus')] },
  { prefix: '/api/wallet-status/bulk-update', read: [v('walletStatus')], write: [act('walletStatus', 'bulkEdit')] },
  { prefix: '/api/sendmoney/wallet-status/bulk-update', read: [v('walletStatus')], write: [act('walletStatus', 'bulkEdit')] },
  { prefix: '/api/v2/wallet-status', read: [v('walletStatus')] },
  // Daily Entry (Pending Balance's tabs read three of its endpoints)
  { prefix: '/api/daily-txn-entry', read: [v('dailyEntry')], write: [e('dailyEntry')] },
  { prefix: '/api/daily-txn-entry/stagnant-balance', read: [v('pendingBalance')], write: [e('dailyEntry')] },
  { prefix: '/api/daily-txn-entry/unreconciled-balance', read: [v('pendingBalance')], write: [e('dailyEntry')] },
  { prefix: '/api/daily-txn-entry/discrepancy-summary', read: [v('pendingBalance')], write: [e('dailyEntry')] },
  // Settings — Admin only, except Transfer Queue's read-only pieces and the
  // Pending Balance TG send/preview endpoints.
  { prefix: '/api/configurations', read: ['settings.manage'], write: ['settings.manage'] },
  { prefix: '/api/configurations/transfer-queue-settings/effective', read: [v('transferQueue')], write: ['settings.manage'] },
  { prefix: '/api/configurations/transfer-queue-settings/linked-accounts', read: [v('transferQueue')], write: ['settings.manage'] },
  { prefix: '/api/configurations/discrepancy-tg/preview', read: [act('pendingBalance', 'telegram')], write: [act('pendingBalance', 'telegram')] },
  { prefix: '/api/configurations/discrepancy-tg/send', read: [act('pendingBalance', 'telegram')], write: [act('pendingBalance', 'telegram')] },
  { prefix: '/api/configurations/unreconciled-tg/preview', read: [act('pendingBalance', 'telegram')], write: [act('pendingBalance', 'telegram')] },
  { prefix: '/api/configurations/unreconciled-tg/send', read: [act('pendingBalance', 'telegram')], write: [act('pendingBalance', 'telegram')] },
  { prefix: '/api/telegram', read: [act('dashboard', 'telegram')], write: [act('dashboard', 'telegram')] },
  { prefix: '/api/internal', read: ANY_TELEGRAM, write: ANY_TELEGRAM },
  // Tickets — finer per-ticket checks (type vs role, own-ticket for
  // leaders) live inside each handler.
  { prefix: '/api/tickets', read: ['tickets.raise', 'tickets.leaderView', ...ANY_TICKET_QUEUE], write: ['tickets.raise', ...TICKET_TITLES.map(ticketSettlePerm)] },
  { prefix: '/api/agents/search', read: ['tickets.raise'] },
  // Users & roles
  { prefix: '/api/admin/users', read: ['users.manage'], write: ['users.manage'] },
  { prefix: '/api/admin/roles', read: ['roles.manage'], write: ['roles.manage'] },
  // Scheduler (session path; the Bearer-secret path is handled in proxy.ts)
  { prefix: '/api/admin/sync-postgres', read: ['system.sync'], write: ['system.sync'] },
  { prefix: '/api/admin/daily-txn-rollover', read: ['system.sync'], write: ['system.sync'] },
  { prefix: '/api/dashboard-demo', read: ['sandbox.view'], write: ['sandbox.view'] },
];

// Checked before API_RULES, for paths with an id in the middle.
const API_PATTERN_RULES: { pattern: RegExp; read: Permission[]; write: Permission[] }[] = [
  // POST /api/tickets/:id/view only bumps a "seen" timestamp — any ticket reader may call it.
  {
    pattern: /^\/api\/tickets\/\d+\/view$/,
    read: ['tickets.raise', 'tickets.leaderView', ...ANY_TICKET_QUEUE],
    write: ['tickets.raise', 'tickets.leaderView', ...ANY_TICKET_QUEUE],
  },
];
const DEFAULT_API_READ: Permission[] = ANY_DATA_VIEW;
const DEFAULT_API_WRITE: Permission[] = ['settings.manage'];

// Routes that check a shared secret themselves (VPS cron) — no session.
export const SECRET_API_PREFIXES = ['/api/cron/', '/api/admin/sync-postgres', '/api/admin/daily-txn-rollover'];
// Available to any signed-in user, even while a password change is pending.
export const ACCOUNT_API_PATHS = ['/api/auth/me', '/api/auth/logout', '/api/auth/change-password'];
export const PUBLIC_API_PATHS = ['/api/auth/login', '/api/auth/logout'];

function matches(pathname: string, prefix: string, exact?: boolean): boolean {
  if (exact) return pathname === prefix;
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function longest<T extends { prefix: string; exact?: boolean }>(rules: T[], pathname: string): T | undefined {
  let best: T | undefined;
  for (const rule of rules) {
    if (matches(pathname, rule.prefix, rule.exact) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best;
}

export function pagePermissions(pathname: string): Permission[] {
  return longest(PAGE_RULES, pathname)?.anyOf ?? DEFAULT_PAGE_RULE;
}

export function isWriteMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

export function apiPermissions(pathname: string, method: string): Permission[] {
  const m = method.toUpperCase();
  const patternRule = API_PATTERN_RULES.find((r) => r.pattern.test(pathname));
  if (patternRule) return isWriteMethod(m) ? patternRule.write : patternRule.read;
  const rule = longest(API_RULES, pathname);
  if (!rule) return isWriteMethod(m) ? DEFAULT_API_WRITE : DEFAULT_API_READ;
  if (!isWriteMethod(m)) return rule.read;
  if (m === 'DELETE') return rule.del ?? rule.write ?? rule.read;
  return rule.write ?? rule.read;
}

export function canOpenPage(perms: Perms, pathname: string): boolean {
  return canAny(perms, pagePermissions(pathname));
}

// Where a user lands after login, or when they open a page they can't see:
// the first page in sidebar order they're allowed to view.
export function homePathFor(perms: Perms): string {
  for (const section of SECTIONS) {
    for (const id of section.pages) {
      if (can(perms, viewPerm(id))) return (PAGES[id] as PageDef).paths[0].path;
    }
  }
  if (can(perms, 'tickets.raise')) return '/tickets';
  if (canAny(perms, ANY_TICKET_QUEUE)) return '/staff/tickets';
  return '/no-access';
}
