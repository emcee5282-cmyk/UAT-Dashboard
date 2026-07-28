import { fromManilaWallClockMs } from './businessDate';
import { isValidNumericCell } from './uploadValidation';

export type EstimateImportRecord = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

// One row skipped during the upload preview's own validation — mirrors
// exactly what app/lib/estimatedOpening.ts's aggregateByShop skips
// server-side (same isValidNumericCell check), so the preview never
// promises a row was skipped when the actual import would've kept it.
export type EstimateRowError = {
  row: number;
  shopCode: string;
  shopName: string;
  column: string;
  value: string;
  message: string;
};

// Inverse of the server's own "MM/DD/YYYY HH:MM AM/PM" timestamp format
// (app/lib/estimatedOpening.ts's formatUploadTimestamp) — written in Manila
// wall-clock time, so parsed the same way here regardless of the viewer's
// own device timezone.
export function parseServerTimestamp(str: string): Date | null {
  const match = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min, ampm] = match;
  let hours = parseInt(hh, 10);
  if (/PM/i.test(ampm) && hours !== 12) hours += 12;
  if (/AM/i.test(ampm) && hours === 12) hours = 0;
  const manilaWallClockMs = Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hours, parseInt(min, 10));
  return fromManilaWallClockMs(manilaWallClockMs);
}

// "Jul 14, 2026 01:42 PM" — display-only formatting for the Last
// Import/Import Success UI. Explicit Asia/Manila timeZone so this always
// reads as the business's own time, regardless of the viewer's own
// device/browser timezone.
export function formatImportTimestamp(serverTimestamp: string): string {
  const date = parseServerTimestamp(serverTimestamp);
  if (!date) return serverTimestamp;
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  const timePart = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
  return `${datePart} ${timePart}`;
}

export type ParsedEstimateRows = {
  detectedShops: number;
  detectedErrors: number;
  rowErrors: EstimateRowError[];
};

// Preview counts — mirrors the server's own aggregateByShop grouping (same
// shop-name extraction, same skip list, same numeric-cell check) so a row
// flagged as an error here is actually excluded at import time too, not
// silently included with a wrong total. Throws if the file is missing its
// "Account" column, matching the server's own findColumn behavior.
export function parseEstimateRows(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
  extractShopName: (raw: string | number) => string,
  skipShopNames: string[]
): ParsedEstimateRows {
  const accountCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'account');
  if (accountCol === -1) {
    throw new Error('The file is missing an "Account" column.');
  }
  const dpCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'total dp');
  const wdCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'total wd');

  const errorRowNumbers = new Set<number>();
  const rowErrors: EstimateRowError[] = [];
  dataRows.forEach((row, i) => {
    // +1 for 0-index, +1 for the header row — matches the row number as it
    // appears in the spreadsheet itself.
    const rowNumber = i + 2;
    const rawAccount = row[accountCol];
    const shopCode = String(rawAccount ?? '').trim() || '(blank)';
    const shopName = extractShopName(rawAccount);

    if (!shopName) {
      errorRowNumbers.add(rowNumber);
      rowErrors.push({
        row: rowNumber, shopCode, shopName: '—', column: 'Account',
        value: String(rawAccount ?? ''), message: 'Missing or invalid shop code',
      });
      return;
    }
    if (skipShopNames.includes(shopName)) return;

    if (dpCol !== -1 && !isValidNumericCell(row[dpCol])) {
      errorRowNumbers.add(rowNumber);
      rowErrors.push({
        row: rowNumber, shopCode, shopName, column: 'Total DP',
        value: String(row[dpCol] ?? ''), message: 'Invalid number format',
      });
    }
    if (wdCol !== -1 && !isValidNumericCell(row[wdCol])) {
      errorRowNumbers.add(rowNumber);
      rowErrors.push({
        row: rowNumber, shopCode, shopName, column: 'Total WD',
        value: String(row[wdCol] ?? ''), message: 'Invalid number format',
      });
    }
  });

  return { detectedShops: dataRows.length, detectedErrors: errorRowNumbers.size, rowErrors };
}
