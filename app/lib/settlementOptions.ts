// Shared option lists for Settlement's New/Edit Record form (both Cashout
// and Send Money import from here) — a single place to update if the brand
// or remarks defaults ever change, instead of two copies drifting apart.
export const SETTLEMENT_BRAND_OPTIONS = ['M1', 'M2', 'K1', 'J1', 'T1', 'B1', 'B2', 'B3', 'B4', 'B5'];

// Wallet options depend on the active Settlement tab — Cashout supports
// Bkash, Send Money doesn't (matches each page's own real wallet set).
export const CASHOUT_WALLET_OPTIONS = ['Nagad', 'Rocket', 'Bkash', 'Upay'];
export const SENDMONEY_WALLET_OPTIONS = ['Nagad', 'Rocket', 'Upay'];

export const SETTLEMENT_REMARKS_SUGGESTIONS = ['INTERNAL TRANSFER', 'STLM TO MC'];
