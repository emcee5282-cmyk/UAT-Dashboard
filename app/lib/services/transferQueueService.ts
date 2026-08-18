// Server-side Transfer Queue service — LOCAL/FOUNDATION ONLY, not wired
// into any existing page or route.
//
// Reuses app/lib/transferQueueRules.ts's resolvers UNCHANGED — the exact
// same SH-based + legacy-fallback logic, byte-for-byte, fed from Postgres
// instead of parsed Sheets/CSV data. "Discrepancy" is confirmed (via direct
// read of app/transfer-queue/page.tsx) to be `companyBalance - balanceInside`
// — the SAME formula as Agent Withdrawal, just a different label in this
// page's context — so it's read directly off getAgentBalances()'s own
// `agentWithdrawal` field rather than recomputed separately.
//
// Phase 1 closed the 3 gaps confirmed in the earlier foundation draft: (1)
// wallet-status originally needed its own Login-override computation here
// since getAgentBalances().walletStatus didn't apply it yet — that upstream
// gap is now fixed (balanceService.ts), so walletStatus is read directly off
// getAgentBalances() below, same as companyBalance/balanceInside/discrepancy
// — no independent computation of it lives here anymore. (2) The three
// live-page filters (top-up-group skip, wallet-status exclusion,
// already-correctly-grouped skip) are applied here, so this returns the
// actual queue, not just per-agent resolution ingredients. (3) Send Money
// Bundle wallets resolve their linked Cashout account's real Company
// Balance instead of always passing null.
//
// Restructured to iterate PER WALLET, not per agent — confirmed via real
// data (1,222 of 2,842 Cashout agents, 27 of 11,273 Send Money agents have
// more than one agent_wallets row) that Current Group is a wallet-level
// fact, not an agent-level one: a shop's Bkash and Nagad wallets can sit in
// genuinely different Groups (e.g. JETT013: one wallet "Wallet with Issue",
// two others "Day DP+WD"). The live Sheets-mode pages already iterate their
// own balRows per wallet row for exactly this reason — an earlier version of
// this file collapsed to one row per agent (last wallet's group silently
// overwriting the rest), which would have produced wrong row counts and
// wrong Current Group for a large share of Cashout shops. Every OTHER
// figure (companyBalance, discrepancy, sdpVsBalance, balanceInside,
// walletStatus) stays agent-level, shared across that agent's wallet rows —
// only currentGroup (and therefore correctGroup/remarks) varies per wallet.
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { computeSdpVsBalance } from '../balanceEngine';
import {
  resolveCashoutCorrectGroup,
  resolveSendMoneyCorrectGroup,
  shouldExcludeBdWallet,
  normalizeGroup,
  type RuleRow,
} from '../transferQueueRules';
import { getAgentBalances, type Product } from './balanceService';
import { readTransferQueueRulesPg, readLinkedAccountsPg, readMetaConfigPg } from '../db/read/transferQueue';
import { DEFAULT_RULES } from '../transferQueueSettings';

export type TransferQueueRow = {
  agentId: number;
  walletId: number;
  agentCode: string;
  // Display-only wallet identifier (the raw Balance Limit sheet's "Account"
  // column, e.g. "01402636932 - N-M1AG-M1-JETT013-NG") — not persisted
  // anywhere in Postgres, so this falls back to agentCode for now. Cosmetic
  // gap only, not blocking: confirmed via explicit instruction.
  account: string;
  brand: string;
  currentGroup: string;
  correctGroup: string;
  companyBalance: number;
  discrepancy: number;
  sdpVsBalance: number;
  balanceInside: number;
  remarks: string;
  walletStatus: string;
};

// Matches both live pages' identical constant exactly.
const EXCLUDED_WALLET_STATUSES = ['Wallet With Issue', 'Disconnected', 'No Record'];

// readTransferQueueRulesPg() returns a plain {section, metric, ...} shape
// matching RuleRow's fields exactly, but typed with generic `string`
// section/operator/metric rather than the exact literal unions
// transferQueueRules.ts's RuleRow expects — safe to assert here since
// section/operator/metric only ever hold values that originated from those
// same literal unions when the rows were written by scripts/migrate-data.ts's
// importTransferQueueRules().
//
// Mode kill-switch — matches transferQueueSettings.ts's own
// readEffectiveTransferQueueRules() exactly: in 'production' mode, ignore
// whatever's saved and evaluate against the hardcoded DEFAULT_RULES instead
// (the instant-rollback lever). Missing here until now — found while
// scoping Phase 4 (the admin Settings UI would have flipped a switch this
// path silently ignored). DEFAULT_RULES itself stays the single source
// (exported from transferQueueSettings.ts, not duplicated).
async function loadRules(): Promise<RuleRow[]> {
  const meta = await readMetaConfigPg();
  if (meta.mode === 'production') {
    return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));
  }
  const rows = await readTransferQueueRulesPg();
  return rows as unknown as RuleRow[];
}

// Send Money's own "raw/unfloored" SDP VS Balance — deliberately distinct
// from balanceEngine.ts's shared computeSdpVsBalance (which floors at
// 30,000 and zeroes on companyBalance <= 0). Confirmed via direct read of
// app/sendmoney/transfer-queue/page.tsx's own computeSdpVsBalanceRaw: no
// floor at all, since this page's own trigger threshold (8,000) sits below
// Agent Balance's 30,000 display floor — pre-flooring here would make the
// 8,001-29,999 range permanently invisible to the resolver. No excluded
// leaders on Send Money (never had any, per that function's own comment).
// The Sheets-era 'NO SDP' text sentinel has no Postgres equivalent —
// agents.sdp is a numeric column, never literal text — so the only
// meaningful case it ever guarded (blank/zero SDP) is already covered by
// the sdpNum === 0 check below.
function computeSdpVsBalanceRaw(sdpNum: number, companyBalance: number): number {
  return sdpNum === 0 ? companyBalance : companyBalance - sdpNum;
}

type WalletGroupRow = { walletId: number; agentId: number; groupCode: string | null };

async function loadWalletGroups(product: Product): Promise<WalletGroupRow[]> {
  const db = getDb();
  return db
    .select({
      walletId: schema.agentWallets.id,
      agentId: schema.agentWallets.agentId,
      groupCode: schema.agentWallets.groupCode,
    })
    .from(schema.agentWallets)
    .innerJoin(schema.agents, eq(schema.agentWallets.agentId, schema.agents.id))
    .where(eq(schema.agents.product, product));
}

export async function getCashoutTransferQueueRows(): Promise<TransferQueueRow[]> {
  const [balances, rules, walletGroups] = await Promise.all([
    getAgentBalances('cashout'),
    loadRules(),
    loadWalletGroups('cashout'),
  ]);

  const balanceByAgentId = new Map(balances.map((b) => [b.agentId, b]));
  const rows: TransferQueueRow[] = [];

  for (const w of walletGroups) {
    const b = balanceByAgentId.get(w.agentId);
    if (!b) continue; // defensive — agent_wallets always FKs to a real agent

    // walletStatus reused directly from getAgentBalances() — same
    // agent-level figure the Balance page shows, Login override included,
    // no independent computation. Applied per wallet iteration, same as the
    // live page (every one of a shop's wallet rows is gated by the SAME
    // agent-level status there too — a wallet literally labeled "Wallet
    // With Issue" is actually excluded by the resolver's own static-group
    // check below, not this gate, matching real behavior confirmed against
    // JETT013).
    const walletStatus = b.walletStatus;
    if (EXCLUDED_WALLET_STATUSES.includes(walletStatus)) continue;

    const currentGroup = (w.groupCode ?? '').trim();
    if (currentGroup.toLowerCase().includes('top up')) continue;

    // Cashout Transfer Queue's own SDP VS Balance has NO excluded-leader
    // list (unlike Agent Balance's ~20-leader list) — the shared
    // computeSdpVsBalance already takes that list as a parameter, so
    // passing [] reproduces the real Transfer Queue formula exactly without
    // a second local copy of the (otherwise identical, floor-having) function.
    const sdpVsBalance = computeSdpVsBalance(b.leader, String(b.sdp), b.sdp, b.companyBalance, []);
    const discrepancy = b.agentWithdrawal;

    const resolved = resolveCashoutCorrectGroup(currentGroup, b.companyBalance, sdpVsBalance, discrepancy, rules);
    if (!resolved) continue;
    if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) continue;

    rows.push({
      agentId: b.agentId, walletId: w.walletId, agentCode: b.agentCode, account: b.agentCode, brand: b.brand,
      currentGroup, correctGroup: resolved.groupName,
      companyBalance: b.companyBalance, discrepancy, sdpVsBalance, balanceInside: b.balanceInside,
      remarks: resolved.remarks, walletStatus,
    });
  }
  return rows;
}

export async function getSendMoneyTransferQueueRows(): Promise<TransferQueueRow[]> {
  const [balances, cashoutBalances, rules, walletGroups, linkedAccounts] = await Promise.all([
    getAgentBalances('sendmoney'),
    getAgentBalances('cashout'),
    loadRules(),
    loadWalletGroups('sendmoney'),
    readLinkedAccountsPg(),
  ]);

  const balanceByAgentId = new Map(balances.map((b) => [b.agentId, b]));
  const cashoutCompanyBalanceByCode = new Map(cashoutBalances.map((b) => [b.agentCode.toUpperCase(), b.companyBalance]));

  const rows: TransferQueueRow[] = [];
  for (const w of walletGroups) {
    const b = balanceByAgentId.get(w.agentId);
    if (!b) continue;

    // walletStatus reused directly from getAgentBalances() — same figure the
    // Balance page shows, Login override included, no independent computation.
    const walletStatus = b.walletStatus;
    if (EXCLUDED_WALLET_STATUSES.includes(walletStatus)) continue;

    const currentGroup = (w.groupCode ?? '').trim();
    if (currentGroup.toLowerCase().includes('top up')) continue;

    const sdpVsBalance = computeSdpVsBalanceRaw(b.sdp, b.companyBalance);
    const discrepancy = b.agentWithdrawal;

    let resolved;
    if (currentGroup.toUpperCase().startsWith('SH')) {
      // SH-prefixed labels (virtually every real Send Money shop today) skip
      // the legacy BD-exclusion gate entirely — Bundle wallets are evaluated
      // against their linked Cashout account's own Company Balance instead.
      const linkedTo = linkedAccounts.get(b.agentCode.toUpperCase());
      const cashoutAccountBalance = linkedTo ? (cashoutCompanyBalanceByCode.get(linkedTo) ?? null) : null;
      resolved = resolveSendMoneyCorrectGroup(currentGroup, b.agentCode, b.brand, b.companyBalance, sdpVsBalance, discrepancy, cashoutAccountBalance, rules);
    } else {
      // Legacy path — shops whose wallet name carries a "BD" segment are
      // excluded from the Transfer Queue by default (keyword gate) unless an
      // enabled BD Limit Configuration rule says otherwise.
      if (shouldExcludeBdWallet(b.agentCode, b.companyBalance, sdpVsBalance, discrepancy, rules)) continue;
      resolved = resolveSendMoneyCorrectGroup(currentGroup, b.agentCode, b.brand, b.companyBalance, sdpVsBalance, discrepancy, null, rules);
    }
    if (!resolved) continue;
    if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) continue;

    rows.push({
      agentId: b.agentId, walletId: w.walletId, agentCode: b.agentCode, account: b.agentCode, brand: b.brand,
      currentGroup, correctGroup: resolved.groupName,
      companyBalance: b.companyBalance, discrepancy, sdpVsBalance, balanceInside: b.balanceInside,
      remarks: resolved.remarks, walletStatus,
    });
  }
  return rows;
}

export type { Product };
