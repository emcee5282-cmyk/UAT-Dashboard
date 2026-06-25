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
