// Shape of the data passed (base64-JSON in the `data` query param) from the
// server-side renderer to the internal render page it screenshots. Kept
// deliberately flat and serializable — no Date objects, no class instances.
// Send to TG v2: no SDP column in the new design (dropped per the v2 page
// template).
import type { LastActiveLabel } from './lastActiveLabel';

export type TgAccountStatus ='Active' | 'Disconnected';

export type TgImageRow = {
  rowNumber: number;
  shopName: string;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  accountStatus: TgAccountStatus;
  // Disconnected rows only — the small "Today"/"Yesterday"/date subline
  // under the status (lastActiveLabel.ts). Absent/null for Active.
  lastActive?: LastActiveLabel | null;
};

export type TgImagePageData = {
  leader: string;
  line: 'cashout' | 'sendmoney';
  pageNumber: number;
  totalPages: number;
  // Pre-formatted (formatBangladeshTimestamp) and shared across every image
  // in one run — "the same timestamp ... on every image in the run", not
  // reformatted per-image.
  timestamp: string;
  // Header's "TOTAL GROUP DISCREPANCY" + "{N} shops" — the sum/count over
  // ALL of this leader+line's positive shops, not just the shops on THIS
  // page, and not just the above-threshold shops that make it into photos
  // at all (identical on photo and PDF pages alike, per spec 4.2).
  headerTotal: number;
  headerShopCount: number;
  rows: TgImageRow[];
};
