import { sendMoneyRoutes } from './sendMoneyRoutes';

// TODO(Phase 3+): Cashout's legacy routes (/agentbal, /summary, /stlm, /topup,
// /transfer-queue) are planned to migrate to clean /cashout/* names matching
// Send Money's scheme (see sendMoneyRoutes.ts). Until then, ROUTE_MAP is a
// temporary bridge between the two naming schemes — it should collapse away
// once Cashout is renamed.

export type Product = 'cashout' | 'sendmoney';

export const CASHOUT_DASHBOARD = '/';
export const SENDMONEY_DASHBOARD = sendMoneyRoutes[0].path; // '/sendmoney'

type RoutePair = { cashout: string; sendmoney: string };

export const ROUTE_MAP: RoutePair[] = [
  { cashout: CASHOUT_DASHBOARD, sendmoney: SENDMONEY_DASHBOARD },
  { cashout: '/agentbal', sendmoney: '/sendmoney/balances' },
  { cashout: '/summary', sendmoney: '/sendmoney/opening' },
  { cashout: '/stlm', sendmoney: '/sendmoney/settlement' },
  { cashout: '/topup', sendmoney: '/sendmoney/topup' },
  { cashout: '/transfer-queue', sendmoney: '/sendmoney/transfer-queue' },
];

// The URL is the single source of truth for the active product — never client
// state. Matches '/sendmoney' exactly or '/sendmoney/...' — not a bare
// startsWith('/sendmoney') — so a future route like /sendmoneyreports can
// never accidentally match.
export function getActiveProduct(pathname: string): Product {
  if (pathname === SENDMONEY_DASHBOARD || pathname.startsWith(`${SENDMONEY_DASHBOARD}/`)) {
    return 'sendmoney';
  }
  return 'cashout';
}

// Resolves the equivalent page in the target product for a given current path.
// Falls back to that product's dashboard root when there's no mapping — never a 404.
export function getCounterpartPath(currentPath: string, targetProduct: Product): string {
  const entry = ROUTE_MAP.find((pair) => pair.cashout === currentPath || pair.sendmoney === currentPath);
  if (!entry) {
    return targetProduct === 'cashout' ? CASHOUT_DASHBOARD : SENDMONEY_DASHBOARD;
  }
  return targetProduct === 'cashout' ? entry.cashout : entry.sendmoney;
}
