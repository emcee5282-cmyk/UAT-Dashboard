import { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, SENDMONEY_WALLET_OPTIONS } from './settlementOptions';

// Top Up shares Settlement's brand/wallet universe verbatim (same shops,
// same wallets) — re-exported here rather than duplicated so a future
// change to either list only has to happen once, in settlementOptions.ts.
export { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, SENDMONEY_WALLET_OPTIONS };

// Unlike Settlement's free-text Remarks, Top Up's Type column is a fixed
// literal per product+page — never observed as anything else in real sheet
// data (see CLAUDE.md's "AG BD STLM + TOPUP"/"PS BD STLM + TOPUP" notes).
// The two products use the *opposite* label from their own Settlement block,
// which already uses the other one — not a typo, a real convention mismatch
// between the two sheets.
export const TOPUP_TYPE_CASHOUT = 'BUNDLE TRANSFER';
export const TOPUP_TYPE_SENDMONEY = 'INTERNAL TRANSFER';
