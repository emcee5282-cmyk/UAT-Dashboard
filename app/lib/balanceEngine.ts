// Shared Balance calculation engine — Cashout (app/agentbal) and Send Money
// (app/sendmoney/balances) confirmed to run byte-identical formulas here,
// differing only in a handful of injected config values (excluded SDP
// leaders, brand code/priority lists, and Send Money's extra
// resolveBrand guard). Anything in this module changes once and applies to
// both products. Wallet-type derivation, column offsets, and other genuine
// per-product rules stay in each page — do not fold those in here.

export function normalizeWalletStatus(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const lower = trimmed.toLowerCase();
  const noSpaces = trimmed.replace(/\s+/g, '').toLowerCase();
  if (noSpaces.includes('dp+wd')) return 'DP+WD';
  if (lower.includes('dp only')) return 'DP Only';
  if (lower.includes('wd only')) return 'WD Only';
  // "Discrepancy"/"Clear Balance" Groups (e.g. "SH- Day Discrepancy / Clear
  // Balance") previously matched none of these checks and silently fell
  // through to the Disconnected default below — these are WD Only per the
  // Group -> Actual Status mapping Payment actually uses.
  if (lower.includes('discrepancy') || lower.includes('clear balance')) return 'WD Only';
  if (lower.includes('top up')) return 'Top Up Acc.';
  if (lower.includes('wallet with issue')) return 'Wallet With Issue';
  if (lower.includes('x group') || lower.includes('disconnected')) return 'Disconnected';
  if (lower.includes('check account problem')) return 'Account Problem';
  return 'Disconnected';
}

export function computeWalletStatus(statuses: string[]): string {
  const normalized = statuses
    .map((s) => normalizeWalletStatus(s))
    .filter((s): s is string => s !== null);

  if (normalized.length === 0) return 'Disconnected';

  const has = (label: string) => normalized.includes(label);

  if (has('DP+WD')) return 'DP + WD';
  if (has('DP Only') && has('WD Only')) return 'DP + WD';
  if (has('DP Only')) return 'DP Only';
  if (has('WD Only')) return 'WD Only';
  if (has('Top Up Acc.')) return 'Top Up Acc.';
  if (has('Wallet With Issue')) return 'Wallet With Issue';
  if (has('Account Problem')) return 'Account Problem';

  return 'Disconnected';
}

export const WALLET_STATUS_OPTIONS = ['DP + WD', 'DP Only', 'WD Only', 'Top Up Acc.', 'Wallet With Issue', 'Disconnected', 'Account Problem', 'No Record'];

// "Balance Inside" rule: a wallet's own `balance` field counts only while
// its Login flag reads "Yes" — shared predicate for that gate.
export function isLoggedIn(login: string): boolean {
  return login.trim().toLowerCase() === 'yes';
}

export function computeCompanyBalance(opening: number, totalDP: number, totalTopUp: number, totalWD: number, totalStlm: number): number {
  return opening + totalDP + totalTopUp - totalWD - totalStlm;
}

export function computeAgentWithdrawal(companyBalance: number, balanceInside: number): number {
  return companyBalance - balanceInside;
}

// A shop's receiving limit floors at 200,000 regardless of SDP — replaces
// what would otherwise be a separate "Minimum SDP" column.
export function computeBaseLimit(sdp: number): number {
  return Math.max(sdp, 200000);
}

// How far Company Balance has already overshot the allowed limit.
export function computeFrozenAmount(companyBalance: number, baseLimit: number): number {
  return Math.max(companyBalance - baseLimit, 0);
}

// Remaining room for today's incoming DP before the shop hits its limit.
// Today's Total DP is subtracted on top of Company Balance (which already
// includes it) per the business rule as specified — not a double-counting
// bug, an intentional extra buffer.
export function computeAvailableLimit(baseLimit: number, companyBalance: number, todayTotalDP: number): number {
  return Math.max(baseLimit - companyBalance - todayTotalDP, 0);
}

export function computeSdpVsBalance(
  leader: string,
  sdpRaw: string,
  sdpNum: number,
  companyBalance: number,
  excludedSdpLeaders: string[]
): number {
  const normalizedLeader = leader.trim().toUpperCase();
  if (excludedSdpLeaders.includes(normalizedLeader)) return 0;

  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  const value = sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;

  if (value < 30000) return 0;
  if (companyBalance <= 0) return 0;

  return value;
}

// SDP allocation across a shop's own wallets — live-computed, never
// persisted (same pattern as Company Balance/SDP VS Balance/Wallet Status
// itself), so it's always automatically current with the shop's real-time
// active-wallet set rather than needing a re-sync trigger. Pure function:
// callers pass each wallet's own pre-computed active/inactive flag
// (deriveWalletFlags()'s trichotomy, with "Wallet With Issue" collapsed
// into inactive — confirmed explicitly, not the page's own 3-way display
// distinction).
//
// Rules (confirmed, not inferred):
//   - Inactive wallets get 0, and never affect the pools' math.
//   - 80% of total SDP -> the BK+Nagad "primary" pool; 20% -> every other
//     active wallet, split EQUALLY (not proportional — no reliable
//     trailing-volume data exists anywhere in this app; confirmed via
//     balanceLimitService.ts's own full delete+replace semantics on every
//     Balance Limit upload, so there's no historical DP/WD window to
//     compute a trend from).
//   - Both BK and Nagad active -> the 80% pool splits 50/50 between them.
//   - Only one of BK/Nagad active -> that one wallet gets the FULL 80%
//     pool alone (never folded into the 20% "other" pool).
//   - No minimum floor per wallet — pure split, even if it lands on a very
//     small number.
//
// Redistribution (confirmed) — a pool with zero eligible recipients folds
// into the other pool rather than going unallocated:
//   - Neither BK nor Nagad active -> the 80% primary pool folds into the
//     20% pool, so 100% splits equally among whatever active non-BK/Nagad
//     wallets exist.
//   - BK/Nagad active but no other active wallets exist -> the 20% pool
//     folds into the 80% pool, so 100% goes to BK/Nagad (50/50 if both
//     active, or entirely to the single active one, per the existing
//     lone-primary rule applied to the now-full pool).
// The only case still left genuinely unallocated: zero active wallets at
// all (nothing anywhere to give the money to) — every wallet gets 0 and
// unallocatedAmount carries the full totalSdp with an explanatory reason,
// which keeps the perWallet-sum-plus-unallocated invariant exactly equal
// to totalSdp in every case, including this one.
const SDP_PRIMARY_WALLET_TYPES = ['BKASH', 'NAGAD'];
const SDP_PRIMARY_POOL_SHARE = 0.8;
const SDP_OTHER_POOL_SHARE = 0.2;

export type SdpAllocationWallet = {
  // Caller's own identifier (e.g. agent_wallets.id) — not assumed unique
  // by walletType, so a shop with an unexpected duplicate wallet type
  // still allocates correctly rather than silently colliding.
  id: number | string;
  walletType: string; // 'BKASH' | 'NAGAD' | 'ROCKET' | 'UPAY'
  isActive: boolean; // Active -> true; Inactive AND Wallet With Issue -> false
};

export type SdpAllocationResult = {
  id: number | string;
  walletType: string;
  allocation: number;
};

export type SdpAllocation = {
  perWallet: SdpAllocationResult[];
  unallocatedAmount: number;
  unallocatedReason: string | null;
};

export function allocateSdpAcrossWallets(totalSdp: number, wallets: SdpAllocationWallet[]): SdpAllocation {
  const perWallet: SdpAllocationResult[] = wallets.map((w) => ({ id: w.id, walletType: w.walletType, allocation: 0 }));
  const byId = new Map(perWallet.map((r) => [r.id, r]));

  const primaryActive = wallets.filter((w) => w.isActive && SDP_PRIMARY_WALLET_TYPES.includes(w.walletType));
  const otherActive = wallets.filter((w) => w.isActive && !SDP_PRIMARY_WALLET_TYPES.includes(w.walletType));

  if (primaryActive.length === 0 && otherActive.length === 0) {
    return { perWallet, unallocatedAmount: totalSdp, unallocatedReason: 'No active wallets at all — nothing to allocate.' };
  }

  // Fold a pool into the other side when its own designated recipients
  // don't exist, per the confirmed redistribution rule — no case reaches
  // the final `return` with money left over once at least one wallet is
  // active.
  const primaryPool = otherActive.length === 0 ? totalSdp : totalSdp * SDP_PRIMARY_POOL_SHARE;
  const otherPool = primaryActive.length === 0 ? totalSdp : totalSdp * SDP_OTHER_POOL_SHARE;

  if (primaryActive.length === 2) {
    for (const w of primaryActive) byId.get(w.id)!.allocation += primaryPool / 2;
  } else if (primaryActive.length === 1) {
    byId.get(primaryActive[0].id)!.allocation += primaryPool;
  }
  // primaryActive.length === 0 -> primaryPool was folded into otherPool above, nothing to assign here.

  if (otherActive.length > 0) {
    const share = otherPool / otherActive.length;
    for (const w of otherActive) byId.get(w.id)!.allocation += share;
  }
  // otherActive.length === 0 -> otherPool was folded into primaryPool above, nothing to assign here.

  return { perWallet, unallocatedAmount: 0, unallocatedReason: null };
}

const DEFAULT_SKIP_GROUPS = ['wallet with issue', 'disconnected', 'dc account'];

export type BrandResolutionConfig = {
  brandPriority: string[];
  brandCodes: string[];
  skipGroups?: string[];
  // Send Money's resolveBrand only trusts computeBrand's result when it's a
  // known code (some Group values, e.g. "BUNDLE WALLET FOR WD", don't start
  // with a real brand code, so a naive first-2-letters slice can produce
  // garbage like "BU"). Cashout has no such guard today — false preserves
  // that exact existing behavior; true reproduces Send Money's guard.
  validateComputedBrand?: boolean;
};

export function computeBrand(groups: string[], config: BrandResolutionConfig): string {
  const skipGroups = config.skipGroups ?? DEFAULT_SKIP_GROUPS;
  const counts = new Map<string, number>();
  groups.forEach((group) => {
    const trimmed = (group ?? '').trim();
    if (!trimmed || trimmed === '-') return;
    if (skipGroups.some((skip) => trimmed.toLowerCase().includes(skip))) return;
    const code = trimmed.slice(0, 2).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  });

  if (counts.size === 0) return '−';

  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.keys()).filter((code) => counts.get(code) === maxCount);
  const priorityTied = tied.filter((code) => config.brandPriority.includes(code));

  if (priorityTied.length > 0) {
    priorityTied.sort((a, b) => config.brandPriority.indexOf(a) - config.brandPriority.indexOf(b));
    return priorityTied[0];
  }

  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

export function resolveBrand(groups: string[], agentName: string, config: BrandResolutionConfig): string {
  const brand = computeBrand(groups, config);
  const trusted = config.validateComputedBrand ? brand !== '−' && config.brandCodes.includes(brand) : brand !== '−';
  if (trusted) return brand;
  return config.brandCodes.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}
