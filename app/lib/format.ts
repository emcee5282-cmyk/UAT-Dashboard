/**
 * Shared formatting utilities for the dashboard.
 * Used by: stlm, topup, agentbal, summary, and dashboard pages.
 */

export function rawVal(val: string): string {
  return (val ?? '').replace(/"/g, '').trim() || '-';
}

export function fmtNum(val: string): string {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return '−';
  const num = parseFloat(cleaned);
  if (isNaN(num)) return '−';
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function displayNum(val: string | number): string {
  const str = String(val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (str === '' || str === '-') return '−';
  const num = parseFloat(str);
  if (isNaN(num) || Math.abs(num) < 0.01) return '−';
  return num.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Excel/XLSX export only — every other helper above returns a formatted
// DISPLAY string ("1,234.56", "−" for blank/zero), which XLSX.utils.aoa_to_sheet
// writes as literal TEXT (left-aligned in Excel, not summable). Per explicit
// instruction: an exported "figure" column must be a genuine number cell,
// and whatever shows on-screen as "-"/"−" (blank/zero/not-applicable) must
// export as the number 0, never that dash text. Accepts the SAME raw
// string/number inputs the on-screen formatters above already take (a
// comma-formatted string, a bare number, or null/undefined) so a getExportValue
// switch can drop this in as a straight replacement for fmt()/displayNum()/
// numOrBlank() without reshaping its own row data first.
export function exportNum(val: string | number | null | undefined): number {
  if (val === null || val === undefined) return 0;
  const str = String(val).replace(/"/g, '').replace(/,/g, '').trim();
  if (str === '' || str === '-' || str === '−') return 0;
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

// Confirmed byte-identical across app/agentbal, app/sendmoney/balances,
// app/balance-overview and app/sendmoney (page.tsx) before extraction —
// summary/page.tsx has its OWN, subtly different fmt (zero renders as '—')
// and was deliberately left alone rather than folded in here.
export function fmt(num: number): string {
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtAbbrev(num: number): string {
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(2)}K`;
  return abs.toFixed(2);
}

// Dashboard-pair specific (app/balance-overview + app/sendmoney) — near-zero
// values collapse to an em-dash, optionally showing a leading "-" for
// negatives (used by Settlement/Withdrawal-style columns).
export function fmtCell(num: number, showSign = false): string {
  if (Math.abs(num) < 0.01) return '—';
  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return showSign && num < 0 ? `-${formatted}` : formatted;
}

// Confirmed byte-identical across app/balance-overview and app/sendmoney
// (page.tsx) before extraction — summary/page.tsx has its OWN, subtly
// different clean() and was deliberately left alone rather than folded in here.
export function clean(val: string): number {
  return parseFloat((val ?? '0').replace(/"/g, '').replace(/,/g, '').trim()) || 0;
}

// Confirmed byte-identical across app/stlm, app/sendmoney/settlement,
// app/topup and app/sendmoney/topup before extraction.
export function parseAmount(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  return parseFloat(cleaned) || 0;
}
