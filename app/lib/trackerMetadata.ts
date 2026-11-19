// Neutral metadata for the leader-facing app ("Tracker"): used by the
// /tickets and /leader layouts (the installable PWA) and the login page.
// Deliberately carries no company/brand name.
import type { Metadata, Viewport } from 'next';

export const TRACKER_METADATA: Metadata = {
  title: 'Tracker',
  description: 'Tracker for team leads.',
  manifest: '/manifest.json',
  icons: {
    icon: [{ url: '/icons/leader-192.png', type: 'image/png', sizes: '192x192' }],
    apple: [{ url: '/icons/leader-192.png' }],
  },
  appleWebApp: { capable: true, title: 'Tracker', statusBarStyle: 'default' },
};

export const TRACKER_VIEWPORT: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};
