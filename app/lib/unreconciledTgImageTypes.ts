// Shape of the data passed (base64-JSON in the `data` query param) from the
// server-side renderer to the internal render page it screenshots — same
// convention as discrepancyTgImageTypes.ts. Kept flat/serializable, no Date
// objects.
export type UnreconciledTgImageRow = {
  rowNumber: number;
  leader: string;
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  sdp: number;
  withheld: number;
};

export type UnreconciledTgImageTotals = {
  companyBalance: number;
  balanceInside: number;
  agentWithdrawal: number;
  sdp: number;
  withheld: number;
};

export type UnreconciledTgView = 'cashout' | 'sendmoney' | 'group';

export type UnreconciledTgImagePageData = {
  view: UnreconciledTgView;
  pageNumber: number; // 1-indexed within this view's own pagination
  totalPages: number; // this view's own page count
  // Pre-formatted (formatBangladeshTimestamp) — this view's Balance tab last
  // upload instant (Group Total uses the later of Cashout/Send Money).
  timestamp: string;
  rows: UnreconciledTgImageRow[];
  // Present ONLY on this view's own last page — the Total row renders
  // distinctly (navy) and only ever appears once per view.
  totals?: UnreconciledTgImageTotals;
};
