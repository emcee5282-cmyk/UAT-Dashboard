// Single source of truth for Send Money's route list. Phase 3's product-switch
// mapping table and the sidebar nav should both read from this instead of
// hardcoding paths/titles per file.
//
// TODO(Phase 3): Cashout's legacy routes (/agentbal, /summary, /stlm, /topup,
// /transfer-queue) are planned to migrate to clean /cashout/* names matching
// this scheme. Until then, the product-switch mapping table is a temporary
// bridge between legacy Cashout paths and these clean Send Money paths — it
// should collapse away once Cashout is renamed.

export type SendMoneyRoute = {
  path: string;
  title: string;
  itemLabel: string;
};

export const sendMoneyRoutes: SendMoneyRoute[] = [
  { path: '/sendmoney', title: 'Send Money', itemLabel: 'records' },
  { path: '/sendmoney/balances', title: 'Agent Balance', itemLabel: 'agents' },
  { path: '/sendmoney/opening', title: 'Opening Balance', itemLabel: 'agents' },
  { path: '/sendmoney/settlement', title: 'Settlement', itemLabel: 'settlements' },
  { path: '/sendmoney/topup', title: 'Top Up', itemLabel: 'top ups' },
  { path: '/sendmoney/transfer-queue', title: 'Transfer Queue', itemLabel: 'transfers' },
];

export function getSendMoneyRoute(path: string): SendMoneyRoute {
  const route = sendMoneyRoutes.find((r) => r.path === path);
  if (!route) {
    throw new Error(`Unknown Send Money route: ${path}`);
  }
  return route;
}
