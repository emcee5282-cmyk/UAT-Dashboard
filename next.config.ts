import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // "/balance-overview" (Cashout's old "SSP Overview" dashboard) and
  // "/sendmoney" (Send Money's own dashboard index) were retired when their
  // content — CashGo/Bundle Transfer Trend, Wallet Summary, Top Performer
  // Wallet, High Volume Agents — was folded into the redesigned "/" Dashboard
  // and the "SSP Overview" nav item was removed. Not `permanent: true`
  // (308) — this is an internal auth-gated tool, not a public/SEO-sensitive
  // site, so a 307 keeps the redirect easy to change later without fighting
  // browser-level redirect caching.
  async redirects() {
    return [
      { source: "/balance-overview", destination: "/", permanent: false },
      { source: "/sendmoney", destination: "/", permanent: false },
    ];
  },
  // Next's own dev-mode build indicator defaults to the bottom-left corner —
  // the same spot the sidebar's account menu button now lives in (dev-only
  // overlap; the indicator doesn't exist in production builds at all, but it
  // was intercepting real clicks on the account button during local dev).
  devIndicators: {
    position: "bottom-right",
  },
  // @sparticuz/chromium loads its compressed Chromium binary (bin/*.br) via
  // dynamic path-joining at runtime, not a static require() — Next's
  // automatic file tracer can't follow that, so the standalone build
  // silently drops the whole bin/ folder (~64MB) unless forced in here.
  outputFileTracingIncludes: {
    "/api/telegram/screenshot": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
