import { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, SENDMONEY_WALLET_OPTIONS } from './settlementOptions';

// Top Up shares Settlement's brand/wallet universe verbatim (same shops,
// same wallets) — re-exported here rather than duplicated so a future
// change to either list only has to happen once, in settlementOptions.ts.
export { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, SENDMONEY_WALLET_OPTIONS };

// Every recognized "money coming in" type, shared by both products (same
// set for Cashout and Send Money's own Bulk Import/Add-Edit Type field —
// per explicit instruction, not product-specific like the old single-
// literal-per-product model this replaced). Formal-cased; nothing here is
// an abbreviation so nothing stays all-caps (contrast Settlement's own
// remarks suggestions, which keep SPC/SDP/STLM/MC caps).
export const TOPUP_TYPE_OPTIONS = ['Bundle Transfer In', 'Internal Transfer In', 'Top Up'];
