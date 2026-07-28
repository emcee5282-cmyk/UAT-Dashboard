// Shared option lists for Settlement's New/Edit Record form (both Cashout
// and Send Money import from here) — a single place to update if the brand
// or remarks defaults ever change, instead of two copies drifting apart.
export const SETTLEMENT_BRAND_OPTIONS = ['M1', 'M2', 'K1', 'J1', 'T1', 'B1', 'B2', 'B3', 'B4', 'B5'];

// Wallet options depend on the active Settlement tab — Cashout supports
// Bkash, Send Money doesn't (matches each page's own real wallet set).
export const CASHOUT_WALLET_OPTIONS = ['Nagad', 'Rocket', 'Bkash', 'Upay'];
export const SENDMONEY_WALLET_OPTIONS = ['Nagad', 'Rocket', 'Upay'];

// Every recognized "money going out" remark, shared by both products — per
// explicit instruction, formal-cased (Title Case) except real abbreviations
// (SPC, SDP, STLM, MC), which stay all-caps. Replaces the old
// ['INTERNAL TRANSFER', 'STLM TO MC'] pair — those two concepts are now the
// more specific 'Internal Transfer Out' and 'STLM To MC' below, not kept as
// separate all-caps duplicates.
export const SETTLEMENT_REMARKS_SUGGESTIONS = [
  'Bundle Transfer Out',
  'Internal Transfer Out',
  'Settlement',
  'STLM To MC',
  'SPC TL Comm',
  'SPC Agent Comm',
  'SPC',
  'SDP Refund',
  'SPC Banking Comm',
];
