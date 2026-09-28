// Shared trimmed + case-insensitive matcher for wallet_transactions.remarks
// against a canonical type list (TOPUP_TYPE_OPTIONS / SETTLEMENT_REMARKS_SUGGESTIONS).
// Used by the Estimated tabs' per-shop-per-type breakdown — never hardcode
// the type names themselves here, only the matching logic; the lists stay in
// topupOptions.ts/settlementOptions.ts as the single source of truth.
export const OTHER_TYPE_LABEL = 'Other';

export function matchTransactionType(remarks: string | null, options: readonly string[]): string {
  const trimmed = (remarks ?? '').trim();
  if (!trimmed) return OTHER_TYPE_LABEL;
  const lower = trimmed.toLowerCase();
  return options.find((o) => o.trim().toLowerCase() === lower) ?? OTHER_TYPE_LABEL;
}

// Builds a zero-filled Record<type, number> so every canonical column always
// renders even when a shop/day has no activity for it (per explicit spec).
export function zeroedTypeMap(options: readonly string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const o of options) map[o] = 0;
  map[OTHER_TYPE_LABEL] = 0;
  return map;
}
