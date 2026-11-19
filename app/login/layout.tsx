// Neutral tab title/description before login (no company name). The page
// itself is unchanged — internal users share it.
//
// Also carries the Tracker manifest: install checkers (PWABuilder, Chrome)
// open /tickets signed out and get redirected here, so the manifest must be
// discoverable on the login page too. The installed app still opens /tickets.
import { TRACKER_METADATA, TRACKER_VIEWPORT } from '@/app/lib/trackerMetadata';

export const metadata = { ...TRACKER_METADATA, description: 'Sign in' };
export const viewport = TRACKER_VIEWPORT;

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
