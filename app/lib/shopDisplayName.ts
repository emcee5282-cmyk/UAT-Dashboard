import { extractOpeningWalletTypeSuffix } from './realShopName';

// One shared shop name for every page — Opening is the source of truth.
// A shop Opening splits into per-wallet lines (opening_wallet_lines, e.g.
// "U-M1AG-L4-BITTER004-BK" / "-NG") is shown under the line matching the
// row's wallet; a shop with no lines is shown under its bare agent_code,
// exactly what the Opening page itself displays for it. Same rules the
// Balance page already applies (balanceService.ts's per-line rows and its
// orphan-wallet name reconstruction), pulled out so Settlement/Top Up can't
// drift from it.
export const OPENING_SUFFIX_TO_WALLET_TYPE: Record<string, string> = {
  BK: 'BKASH', NG: 'NAGAD', RK: 'ROCKET', UP: 'UPAY',
};
export const WALLET_TYPE_TO_OPENING_SUFFIX: Record<string, string> = {
  BKASH: 'BK', NAGAD: 'NG', ROCKET: 'RK', UPAY: 'UP',
};

// The names Opening shows for one shop — its wallet-line names if it has
// any, else its bare agent_code. Used to build the Settlement/Top Up
// roster client-side (same rule as shopNameLookup.ts server-side).
export function openingShopNames(agentCode: string, lineRawNames: string[]): string[] {
  return lineRawNames.length > 0 ? lineRawNames : [agentCode];
}

// A name carrying a wallet suffix ("...-BK", "RANGER028NG") must be posted
// with that same wallet — otherwise the row is shown and counted under a
// different wallet line than the name says. An unrecognized wallet passes
// here (checkWalletField already flags it); a name with no suffix always passes.
export function shopNameWalletMismatch(shopName: string, wallet: string): { expectedSuffix: string } | null {
  const suffix = extractOpeningWalletTypeSuffix(shopName);
  if (!suffix) return null;
  const walletSuffix = WALLET_TYPE_TO_OPENING_SUFFIX[wallet.trim().toUpperCase()];
  if (!walletSuffix || walletSuffix === suffix) return null;
  return { expectedSuffix: suffix };
}

export function resolveShopDisplayName(agentCode: string, lineRawNames: string[], wallet: string | null | undefined): string {
  if (lineRawNames.length === 0) return agentCode;
  // Stored wallet text is mixed-case ("BKASH"/"Bkash"/"bkash") — compare upper.
  const suffix = wallet ? WALLET_TYPE_TO_OPENING_SUFFIX[wallet.trim().toUpperCase()] : undefined;
  if (!suffix) return lineRawNames.length === 1 ? lineRawNames[0] : agentCode;
  const match = lineRawNames.find((raw) => extractOpeningWalletTypeSuffix(raw) === suffix);
  if (match) return match;
  // Wallet Opening has no line for — same sibling-template reconstruction
  // as Balance's orphan-wallet rows.
  return lineRawNames[0].replace(/-[A-Za-z]{2}$/, `-${suffix}`);
}
