// Generates drizzle/0045_add_roles.sql's seed rows from the permission
// catalog (so no key can be mistyped). Re-run only if the approved default
// access table changes before rollout:
//   npx tsx scripts/_gen-roles-seed.ts > /tmp/seed.sql
import {
  PAGE_IDS,
  PAGES,
  actionPerm,
  editPerm,
  ticketSettlePerm,
  ticketViewPerm,
  viewPerm,
  type Permission,
} from '../app/lib/auth/permissions';

const allViews = PAGE_IDS.map(viewPerm);
const records = ['opening', 'settlement', 'topup'] as const;

const ROLES: { key: string; name: string; description: string; locked?: boolean; hidden?: boolean; perms: Permission[] }[] = [
  { key: 'admin', name: 'Admin', description: 'Full access, including Settings and Users & Roles. Locked.', locked: true, perms: [] },
  {
    key: 'supervisor',
    name: 'Supervisor',
    description: 'Views every page and ticket; cannot edit, upload, send or settle.',
    perms: [...allViews, ...(['agent_concern', 'shop_replacement', 'adding_new_account'] as const).map(ticketViewPerm)],
  },
  {
    key: 'ops',
    name: 'OPS',
    description: 'Data entry on every page, Telegram sends, settles Agent concern tickets.',
    perms: [
      ...allViews,
      ...records.flatMap((id) => [editPerm(id), actionPerm(id, 'upload'), actionPerm(id, 'delete'), actionPerm(id, 'bulkEdit')]),
      editPerm('dailyEntry'),
      editPerm('walletStatus'),
      actionPerm('walletStatus', 'bulkEdit'),
      actionPerm('balance', 'upload'),
      actionPerm('dashboard', 'telegram'),
      actionPerm('pendingBalance', 'telegram'),
      ticketViewPerm('agent_concern'),
      ticketSettlePerm('agent_concern'),
    ],
  },
  {
    key: 'acc',
    name: 'ACC',
    description: 'Views dashboards; settles Shop replacement and Adding new account tickets.',
    perms: [
      ...allViews.filter((p) => p !== viewPerm('dailyEntry')),
      ticketViewPerm('shop_replacement'),
      ticketSettlePerm('shop_replacement'),
      ticketViewPerm('adding_new_account'),
      ticketSettlePerm('adding_new_account'),
    ],
  },
  { key: 'leader', name: 'Leader', description: 'Raises tickets for their own shops/agents only.', perms: ['tickets.raise'] },
  { key: 'viewer', name: 'Viewer', description: 'Read-only dashboards. No edit, upload or send buttons.', perms: allViews },
  { key: 'system', name: 'System', description: 'Scheduler service account (sync only). Hidden.', hidden: true, perms: ['system.sync'] },
];

void PAGES;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const out: string[] = [];
out.push(
  `INSERT INTO "roles" ("key", "name", "description", "locked", "hidden") VALUES\n` +
    ROLES.map((r) => `\t(${q(r.key)}, ${q(r.name)}, ${q(r.description)}, ${!!r.locked}, ${!!r.hidden})`).join(',\n') +
    `\nON CONFLICT ("key") DO NOTHING;`
);
out.push(
  `INSERT INTO "role_permissions" ("role_id", "permission")\nSELECT r."id", v."permission" FROM (VALUES\n` +
    ROLES.flatMap((r) => r.perms.map((p) => `\t(${q(r.key)}, ${q(p)})`)).join(',\n') +
    `\n) AS v("role_key", "permission")\nJOIN "roles" r ON r."key" = v."role_key"\n` +
    `-- Only roles with no permissions yet: re-running never undoes edits made on the Roles screen.\n` +
    `WHERE NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id")\nON CONFLICT DO NOTHING;`
);
console.log(out.join('\n--> statement-breakpoint\n'));
