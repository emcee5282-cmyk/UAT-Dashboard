// Google Sheets vs PostgreSQL reconciliation — READ-ONLY against Sheets,
// READ-ONLY against Postgres. Computes the same balance metrics both ways
// (Sheets side via the live dashboard's own column layout + the exact same
// balanceEngine.ts functions the Postgres side uses; Postgres side via
// app/lib/services/balanceService.ts) and reports MATCH/DIFFERENCE per
// agent per metric. Nothing is written anywhere by this script.
//
// Run with: npx tsx --env-file=.env.local scripts/reconcile.ts [cashout|sendmoney]
import { config } from 'dotenv';
config({ path: '.env.local' });
import { fetchRange, fetchBalanceLimitRows } from '../app/lib/googleSheets';
import {
  computeCompanyBalance, computeAgentWithdrawal, computeBaseLimit,
  computeFrozenAmount, computeAvailableLimit, computeSdpVsBalance,
  computeWalletStatus, isLoggedIn,
} from '../app/lib/balanceEngine';
import { getBusinessToday } from '../app/lib/businessDate';
import { getAgentBalances, type Product } from '../app/lib/services/balanceService';

const CASHOUT_EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE', 'MUNIM', 'NIHJUM',
  'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN', 'ROSE', 'SAM', 'XYZ', 'SHAKIL',
  'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR',
];

function cleanText(v: unknown): string { return String(v ?? '').replace(/"/g, '').trim(); }
function num(v: unknown): number { const n = parseFloat(cleanText(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function isRosterInvalid(name: string): boolean { return !name || name === '-' || name.toUpperCase() === 'OLD'; }

// Same convention as scripts/migrate-data.ts's importWalletTransactions() —
// STLM+TOPUP "To Agent" values sometimes carry a trailing "-<brand>" suffix
// (e.g. "D-M1BD-GOLD001-NG-B3") that isn't part of the real roster key
// ("D-M1BD-GOLD001-NG"). Must strip it here too so this script's txByAgent
// lookup key matches what the production import pipeline actually stores
// against — without this, any suffixed row's Top Up/Settlement silently
// falls through to the txByAgent.get() miss and reads as 0 on the Sheets
// side, producing a false mismatch against Postgres's correct value.
const BRAND_SUFFIX_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  if (parts.length >= 2 && BRAND_SUFFIX_CODES.includes(last)) return parts.slice(0, -1).join('-');
  return name;
}
function parseSlashDate(raw: string): Date | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

type SheetsAgentBalance = {
  agentCode: string; leader: string; sdp: number; openingBalance: number;
  totalDp: number; totalWd: number; totalTopUp: number; totalSettlement: number;
  companyBalance: number; balanceInside: number; agentWithdrawal: number;
  baseLimit: number; frozenAmount: number; availableLimit: number;
  sdpVsBalance: number; walletStatus: string;
};

async function computeSheetsSide(product: Product): Promise<Map<string, SheetsAgentBalance>> {
  const openingRange = product === 'cashout' ? 'Opening AG!A2:D' : 'Opening AG!L2:O';
  const openingRows = await fetchRange(openingRange);
  const balRows = product === 'cashout' ? await fetchBalanceLimitRows() : await fetchRange('SSP PS BalanceLimit');
  const stlmSheet = product === 'cashout' ? 'AG BD STLM + TOPUP' : 'PS BD STLM + TOPUP';
  const stlmRows = await fetchRange(stlmSheet);

  const businessToday = getBusinessToday();

  const roster = new Map<string, { leader: string; sdp: string; opening: number }>();
  for (const row of openingRows) {
    const code = cleanText(row[0]);
    if (isRosterInvalid(code)) continue;
    roster.set(code, { leader: cleanText(row[3]), sdp: cleanText(row[2]), opening: num(row[1]) });
  }

  const nameIdx = product === 'cashout' ? 1 : 0;
  const statusIdx = product === 'cashout' ? 2 : 1;
  const walletsByAgent = new Map<string, { balance: number; totalDp: number; totalWd: number; isLoggedIn: boolean; accountStatus: string }[]>();
  for (const row of balRows.slice(1)) {
    const code = cleanText(row[nameIdx]);
    if (isRosterInvalid(code)) continue;
    if (!walletsByAgent.has(code)) walletsByAgent.set(code, []);
    walletsByAgent.get(code)!.push({
      balance: num(row[8]), totalDp: num(row[11]), totalWd: num(row[13]),
      isLoggedIn: isLoggedIn(cleanText(row[15])), accountStatus: cleanText(row[2]),
    });
  }

  const txByAgent = new Map<string, { topUp: number; settlement: number }>();
  for (const row of stlmRows.slice(1)) {
    const topupAgent = stripBrandSuffix(cleanText(row[1]));
    const topupDate = parseSlashDate(cleanText(row[3]));
    if (topupAgent && topupAgent !== '-' && topupDate && topupDate.getTime() === businessToday.getTime()) {
      const bucket = txByAgent.get(topupAgent) ?? { topUp: 0, settlement: 0 };
      bucket.topUp += Math.abs(num(row[2]));
      txByAgent.set(topupAgent, bucket);
    }
    const stlmAgent = stripBrandSuffix(cleanText(row[7]));
    const stlmDate = parseSlashDate(cleanText(row[9]));
    if (stlmAgent && stlmAgent !== '-' && stlmDate && stlmDate.getTime() === businessToday.getTime()) {
      const bucket = txByAgent.get(stlmAgent) ?? { topUp: 0, settlement: 0 };
      bucket.settlement += Math.abs(num(row[8]));
      txByAgent.set(stlmAgent, bucket);
    }
  }

  const excludedSdpLeaders = product === 'cashout' ? CASHOUT_EXCLUDED_SDP_LEADERS : [];
  const result = new Map<string, SheetsAgentBalance>();

  for (const [code, info] of roster) {
    const wallets = walletsByAgent.get(code) ?? [];
    const totalDp = wallets.reduce((s, w) => s + w.totalDp, 0);
    const totalWd = wallets.reduce((s, w) => s + w.totalWd, 0);
    const balanceInside = wallets.reduce((s, w) => s + (w.isLoggedIn ? w.balance : 0), 0);
    const tx = txByAgent.get(code) ?? { topUp: 0, settlement: 0 };
    const sdpNum = num(info.sdp);

    const companyBalance = computeCompanyBalance(info.opening, totalDp, tx.topUp, totalWd, tx.settlement);
    const agentWithdrawal = computeAgentWithdrawal(companyBalance, balanceInside);
    const baseLimit = computeBaseLimit(sdpNum);
    const frozenAmount = computeFrozenAmount(companyBalance, baseLimit);
    const availableLimit = computeAvailableLimit(baseLimit, companyBalance, totalDp);
    const sdpVsBalance = computeSdpVsBalance(info.leader, info.sdp, sdpNum, companyBalance, excludedSdpLeaders);
    const walletStatus = computeWalletStatus(wallets.map((w) => w.accountStatus));

    result.set(code, {
      agentCode: code, leader: info.leader, sdp: sdpNum, openingBalance: info.opening,
      totalDp, totalWd, totalTopUp: tx.topUp, totalSettlement: tx.settlement,
      companyBalance, balanceInside, agentWithdrawal, baseLimit, frozenAmount, availableLimit,
      sdpVsBalance, walletStatus,
    });
  }
  return result;
}

type Diff = { agentCode: string; metric: string; sheets: string | number; postgres: string | number; diff: string };

function compareNumeric(agentCode: string, metric: string, sheetsVal: number, pgVal: number, diffs: Diff[], tolerance = 0.01) {
  if (Math.abs(sheetsVal - pgVal) > tolerance) {
    diffs.push({ agentCode, metric, sheets: sheetsVal.toFixed(2), postgres: pgVal.toFixed(2), diff: (sheetsVal - pgVal).toFixed(2) });
  }
}

async function main() {
  const product = (process.argv[2] === 'sendmoney' ? 'sendmoney' : 'cashout') as Product;
  console.log(`=== Reconciliation: ${product} ===\n`);

  const [sheetsMap, pgRows] = await Promise.all([computeSheetsSide(product), getAgentBalances(product)]);
  const pgMap = new Map(pgRows.map((r) => [r.agentCode, r]));

  const diffs: Diff[] = [];
  let compared = 0, exactMatches = 0, onlyInSheets = 0, onlyInPg = 0;

  for (const [code, s] of sheetsMap) {
    const p = pgMap.get(code);
    if (!p) { onlyInSheets++; continue; }
    compared++;
    const before = diffs.length;
    compareNumeric(code, 'Opening Balance', s.openingBalance, p.openingBalance, diffs);
    compareNumeric(code, 'Total DP', s.totalDp, p.totalDp, diffs);
    compareNumeric(code, 'Total WD', s.totalWd, p.totalWd, diffs);
    compareNumeric(code, 'Total Top Up (today)', s.totalTopUp, p.totalTopUp, diffs);
    compareNumeric(code, 'Total Settlement (today)', s.totalSettlement, p.totalSettlement, diffs);
    compareNumeric(code, 'Company Balance', s.companyBalance, p.companyBalance, diffs);
    compareNumeric(code, 'Balance Inside', s.balanceInside, p.balanceInside, diffs);
    compareNumeric(code, 'Agent Withdrawal', s.agentWithdrawal, p.agentWithdrawal, diffs);
    compareNumeric(code, 'Base Limit', s.baseLimit, p.baseLimit, diffs);
    compareNumeric(code, 'Frozen Amount', s.frozenAmount, p.frozenAmount, diffs);
    compareNumeric(code, 'Available Limit', s.availableLimit, p.availableLimit, diffs);
    compareNumeric(code, 'SDP VS Balance', s.sdpVsBalance, p.sdpVsBalance, diffs);
    if (s.walletStatus !== p.walletStatus) diffs.push({ agentCode: code, metric: 'Wallet Status', sheets: s.walletStatus, postgres: p.walletStatus, diff: 'mismatch' });
    if (diffs.length === before) exactMatches++;
  }
  for (const code of pgMap.keys()) if (!sheetsMap.has(code)) onlyInPg++;

  console.log(`Agents compared: ${compared}`);
  console.log(`Fully exact matches (every metric): ${exactMatches}`);
  console.log(`Agents with at least one difference: ${compared - exactMatches}`);
  console.log(`Only in Sheets (missing from Postgres): ${onlyInSheets}`);
  console.log(`Only in Postgres (missing from Sheets): ${onlyInPg}`);
  console.log(`Total individual metric differences: ${diffs.length}\n`);

  // Aggregate by metric so real patterns (e.g. "every agent's Total DP is
  // off by a small live-drift amount") are visible, not just a wall of rows.
  const byMetric = new Map<string, Diff[]>();
  for (const d of diffs) {
    if (!byMetric.has(d.metric)) byMetric.set(d.metric, []);
    byMetric.get(d.metric)!.push(d);
  }
  for (const [metric, rows] of byMetric) {
    console.log(`--- ${metric}: ${rows.length} differences (showing up to 5) ---`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.agentCode}: Sheets=${r.sheets}  Postgres=${r.postgres}  Diff=${r.diff}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error('RECONCILE FAILED', e); process.exit(1); });
