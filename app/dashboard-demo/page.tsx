'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Standalone mockup — deliberately NOT wired into AppShell/Sidebar or any
// shared component. The mockup ships its own complete sidebar/header/theme
// toggle as plain HTML+CSS+JS (public/dashboard-demo.html), so it's served
// as-is via iframe rather than converted to React — keeps this 100% isolated
// from the real app (no shared state, no risk of the demo's own vanilla-JS
// DOM manipulation touching anything live).
//
// Rendered via createPortal straight into document.body rather than plain
// `position:fixed` in-place: every page's children pass through
// PageTransition (app/components/PageTransition.tsx), which applies an
// inline CSS `transform` for its enter animation — a transformed ancestor
// creates a new containing block for `position:fixed` descendants, so a
// plain fixed overlay here would end up positioned relative to that
// wrapper (offset right by the real sidebar's width) instead of the true
// viewport, letting the real Sidebar show through on the left (confirmed
// live). Portaling to document.body escapes that ancestor chain entirely.
export default function DashboardDemoPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    document.title = 'Dashboard Demo';
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <iframe
      src="/dashboard-demo.html"
      title="Dashboard Demo"
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', border: 'none', zIndex: 9999 }}
    />,
    document.body
  );
}
