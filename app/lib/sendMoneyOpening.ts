import { BRAND_CODES } from '@/app/lib/transferQueueCount';

// Send Money has its own brand ("SH") not present in Cashout's roster —
// scoped here so Cashout's BRAND_CODES/behavior stays untouched.
const SENDMONEY_BRAND_CODES = [...BRAND_CODES, 'SH'];

export type SendMoneyOpeningRow = {
  agentName: string;
  leader: string;
  brand: string | null;
  openingBalance: number | null;
  securityDeposit: number | null;
};

// A blank cell means "not set" — must stay null, not become 0, so sums/counts
// (e.g. "No Opening Yet") can tell the difference from a genuine zero balance.
function parseNullableNumber(raw: string | undefined): number | null {
  const cleaned = (raw ?? '').replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Brand isn't a column in this range — it's embedded in the Wallet Name itself,
// e.g. "N-B2PS1-KYAR001-RK" -> segment "B2PS1" -> brand code "B2".
function resolveBrandFromWalletName(walletName: string): string | null {
  const segment = (walletName.split('-')[1] ?? '').toUpperCase();
  return SENDMONEY_BRAND_CODES.find((code) => segment.startsWith(code)) ?? null;
}

export function parseSendMoneyOpeningCsv(csv: string): SendMoneyOpeningRow[] {
  const lines = csv.trim().split('\n').slice(1);
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cols = line.split(',');
      const agentName = (cols[0] ?? '').replace(/"/g, '').trim();
      const leader = (cols[3] ?? '').replace(/"/g, '').trim();
      return {
        agentName,
        leader,
        brand: resolveBrandFromWalletName(agentName),
        openingBalance: parseNullableNumber(cols[1]),
        securityDeposit: parseNullableNumber(cols[2]),
      };
    })
    .filter((row) => row.agentName && row.agentName !== 'OLD');
}
