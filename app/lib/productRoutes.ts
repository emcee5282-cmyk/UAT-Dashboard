import { sendMoneyRoutes } from './sendMoneyRoutes';

// TODO(Phase 3+): Cashout's legacy routes (/agentbal, /summary, /stlm, /topup,
// /transfer-queue) are planned to migrate to clean /cashout/* names matching
// Send Money's scheme (see sendMoneyRoutes.ts). Until then, ROUTE_MAP is a
// temporary bridge between the two naming schemes — it should collapse away
// once Cashout is renamed.

export type Product = 'cashout' | 'sendmoney';

// Dashboard and Overview swapped URLs — Overview is now the site's root
// landing page ('/'), Dashboard (Cashout's own Cash Out Wallets page) moved
// to '/balance-overview'. Only the routes changed; each page's own content
// moved with it (see app/page.tsx and app/balance-overview/page.tsx).
export const CASHOUT_DASHBOARD = '/balance-overview';
export const SENDMONEY_DASHBOARD = sendMoneyRoutes[0].path; // '/sendmoney'

type RoutePair = { cashout: string; sendmoney: string };

export const ROUTE_MAP: RoutePair[] = [
  { cashout: CASHOUT_DASHBOARD, sendmoney: SENDMONEY_DASHBOARD },
  { cashout: '/agentbal', sendmoney: '/sendmoney/balances' },
  { cashout: '/summary', sendmoney: '/sendmoney/opening' },
  { cashout: '/stlm', sendmoney: '/sendmoney/settlement' },
  { cashout: '/topup', sendmoney: '/sendmoney/topup' },
  { cashout: '/transfer-queue', sendmoney: '/sendmoney/transfer-queue' },
  // Balance Overview combines both products on one page — self-mapped so it
  // never redirects away when the Cashout/Send Money switcher is toggled.
  // Now lives at '/' (the site's landing page).
  { cashout: '/', sendmoney: '/' },
];

// A "shared" route resolves to the identical path for both products (only
// Balance Overview today) — the URL alone can't distinguish which product is
// selected there, which is why the ?product= query param exists at all.
function isSharedRoute(pathname: string): boolean {
  const entry = ROUTE_MAP.find((pair) => pair.cashout === pathname || pair.sendmoney === pathname);
  return !!entry && entry.cashout === entry.sendmoney;
}

// Every page where Cashout and Send Money are genuinely different pages —
// Dashboard, Balance, Opening, Settlement, Top Up, Transfer Queue — as
// opposed to the shared Balance Overview page (same URL for both, already
// distinguished via ?product=). Only these show the FloatingHeader's
// Cashout/Send Money tabs; equivalent to "not a shared route".
export function isProductSwitchRoute(pathname: string): boolean {
  const entry = ROUTE_MAP.find((pair) => pair.cashout === pathname || pair.sendmoney === pathname);
  return !!entry && entry.cashout !== entry.sendmoney;
}

// The URL is the single source of truth for the active product — never client
// state. Matches '/sendmoney' exactly or '/sendmoney/...' — not a bare
// startsWith('/sendmoney') — so a future route like /sendmoneyreports can
// never accidentally match.
//
// `productParam` is the ?product= query value (only meaningful, and only
// honored, on shared routes — everywhere else the path itself is authoritative).
export function getActiveProduct(pathname: string, productParam?: string | null): Product {
  if ((productParam === 'cashout' || productParam === 'sendmoney') && isSharedRoute(pathname)) {
    return productParam;
  }
  if (pathname === SENDMONEY_DASHBOARD || pathname.startsWith(`${SENDMONEY_DASHBOARD}/`)) {
    return 'sendmoney';
  }
  return 'cashout';
}

// Resolves the equivalent page in the target product for a given current path.
// Falls back to that product's dashboard root when there's no mapping — never a 404.
// Shared routes get a ?product= query appended so switching products there is
// an actual navigation (same path otherwise means router.push() is a no-op
// and nothing re-renders as active).
export function getCounterpartPath(currentPath: string, targetProduct: Product): string {
  const entry = ROUTE_MAP.find((pair) => pair.cashout === currentPath || pair.sendmoney === currentPath);
  if (!entry) {
    return targetProduct === 'cashout' ? CASHOUT_DASHBOARD : SENDMONEY_DASHBOARD;
  }
  const target = targetProduct === 'cashout' ? entry.cashout : entry.sendmoney;
  return entry.cashout === entry.sendmoney ? `${target}?product=${targetProduct}` : target;
}
