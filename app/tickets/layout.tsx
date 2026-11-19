// Leader ticket pages are also the installed app's start page (manifest
// start_url /tickets) — same neutral title/manifest as /leader.
import { TRACKER_METADATA, TRACKER_VIEWPORT } from '@/app/lib/trackerMetadata';

export const metadata = TRACKER_METADATA;
export const viewport = TRACKER_VIEWPORT;

export default function TicketsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
