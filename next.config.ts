import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
