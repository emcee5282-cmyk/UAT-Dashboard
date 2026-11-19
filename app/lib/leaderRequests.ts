// Leader portal: top-up / settlement requests (tickets with title
// topup_request / settlement_request). Pure data + helpers, safe for both
// client and server. Approving a request is a ticket status change only —
// nothing here writes wallet_transactions.

export const REQUEST_TITLES = ['topup_request', 'settlement_request'] as const;
export type RequestTitle = (typeof REQUEST_TITLES)[number];

export const REQUEST_LABEL: Record<RequestTitle, string> = {
  topup_request: 'Top-up request',
  settlement_request: 'Settlement request',
};

// Same wallet names wallet_transactions.wallet uses.
export const REQUEST_WALLETS = ['Bkash', 'Nagad', 'Rocket', 'Upay'] as const;
export type RequestWallet = (typeof REQUEST_WALLETS)[number];

export const MAX_REQUEST_AMOUNT = 100_000_000;

export function isRequestTitle(title: string): title is RequestTitle {
  return (REQUEST_TITLES as readonly string[]).includes(title);
}

// Leader-facing status: pending + ongoing both read as Pending, settled is
// Approved. Only the /leader pages use this — the existing /tickets pages
// keep their own four labels.
export type LeaderStatus = 'pending' | 'approved' | 'rejected';
export function leaderStatus(status: string): LeaderStatus {
  if (status === 'settled') return 'approved';
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

export const LEADER_STATUS_STYLE: Record<LeaderStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  approved: { label: 'Approved', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' },
};

// Validates a request amount: positive, at most 2 decimals, below the cap.
// Returns the normalized string for the numeric(18,2) column, or null.
export function parseRequestAmount(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > MAX_REQUEST_AMOUNT) return null;
  return n.toFixed(2);
}

export function formatAmount(value: string | number | null | undefined): string {
  if (value == null || value === '') return '−';
  const n = Number(value);
  if (!Number.isFinite(n)) return '−';
  const decimals = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: 2 });
}
