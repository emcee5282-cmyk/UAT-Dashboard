import { rawVal } from './format';
import { parseCsvLines } from './csv';
import { getBusinessToday } from './businessDate';

// Shared by both live consumers of the Send Money Bundle -> linked Cashout
// account lookup (app/lib/transferQueueCount.ts's sidebar badge count, and
// app/sendmoney/transfer-queue/page.tsx's actual queue table) so the two
// can never drift out of sync on what a given Cashout agent's Company
// Balance actually is — same reasoning app/lib/transferQueueRules.ts's own
// header comment gives for deduplicating the resolver logic itself.
//
// Callers already fetch `/api/opening` for their OWN roster (Send Money's
// own cols L-O) — `openingText` here is that exact same response, just
// re-parsed for Cashout's cols A-D instead. `agentBalText`/`agstlmText` are
// NEW fetches (`/api/agentbal`, `/api/agstlmtopup`) neither Send Money
// consumer previously needed.

const CASHOUT_BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseSheetDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && CASHOUT_BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

// Company Balance = Opening + Total DP + Top Up - Total WD - Settlement,
// same formula/cutoff convention as app/transfer-queue/page.tsx's own
// (Cashout's real, live) computation — Top Up/Settlement filtered to
// today's business day via getBusinessToday(), not gated on Opening's own
// "Updated Time" card refresh.
export function computeCashoutCompanyBalanceByAgent(
  openingText: string,
  agentBalText: string,
  agstlmText: string
): Map<string, number> {
  const openingRows = parseCsvLines(openingText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => ({ agentName: rawVal(row[0]), openingBal: rawVal(row[1]) }))
    .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

  const balanceTotals = new Map<string, { dp: number; wd: number }>();
  parseCsvLines(agentBalText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .forEach((row) => {
      const name = rawVal(row[1]);
      if (!name || name === '-') return;
      const dp = parseFloat(rawVal(row[11]).replace(/,/g, '')) || 0;
      const wd = parseFloat(rawVal(row[13]).replace(/,/g, '')) || 0;
      const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
      balanceTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });
    });

  const reportCutoffDate = getBusinessToday();
  const topUpTotals = new Map<string, number>();
  const stlmTotals = new Map<string, number>();
  parseCsvLines(agstlmText)
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .forEach((row) => {
      const topUpAgent = stripBrandSuffix(rawVal(row[1]));
      const topUpAmount = rawVal(row[2]);
      const topUpDate = parseSheetDate(rawVal(row[3]));
      if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' && topUpDate && topUpDate >= reportCutoffDate) {
        const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
        topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
      }
      const stlmAgent = stripBrandSuffix(rawVal(row[7]));
      const stlmAmount = rawVal(row[8]);
      const stlmDate = parseSheetDate(rawVal(row[9]));
      if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' && stlmDate && stlmDate >= reportCutoffDate) {
        const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
        stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
      }
    });

  const companyBalanceByAgent = new Map<string, number>();
  openingRows.forEach((opening) => {
    const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
    const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
    const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
    const companyBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
    companyBalanceByAgent.set(opening.agentName.toUpperCase(), companyBalance);
  });

  return companyBalanceByAgent;
}
