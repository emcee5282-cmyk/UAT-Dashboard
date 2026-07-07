import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // @sparticuz/chromium loads its compressed Chromium binary (bin/*.br) via
  // dynamic path-joining at runtime, not a static require() — Next's
  // automatic file tracer can't follow that, so the standalone build
  // silently drops the whole bin/ folder (~64MB) unless forced in here.
  outputFileTracingIncludes: {
    "/api/telegram/screenshot": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
