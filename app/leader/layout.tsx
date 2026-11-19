import { TRACKER_METADATA, TRACKER_VIEWPORT } from '@/app/lib/trackerMetadata';

export const metadata = TRACKER_METADATA;
export const viewport = TRACKER_VIEWPORT;

export default function LeaderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
