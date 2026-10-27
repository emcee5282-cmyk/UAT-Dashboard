// Excel export for Pending Balance's "Stagnant Balances" tab — same
// exceljs cell-styling convention as discrepancySummaryExport.ts (this
// feature's own sibling tab), reused byte-for-byte: Calibri 10, navy
// #1F4E78 header/leader-subtotal/Total rows, thin #BFBFBF borders, #,##0
// number format, 20-wide columns, header row frozen.
//
// Takes the already-aggregated views the page itself renders
// (StagnantAllViews from stagnantBalanceAggregate.ts) — no re-querying, and
// always exports every leader/shop regardless of which rows are expanded
// or which card is selected on the page.
import ExcelJS from 'exceljs';
import type { StagnantAllViews, StagnantViewResult } from './stagnantBalanceAggregate';

const WHITE = 'FFFFFFFF';
const BLACK = 'FF000000';
const NAVY = 'FF1F4E78';
const GRAY = 'FFE7E6E6';
const BORDER_COLOR = 'FFBFBFBF';
const NUMBER_FORMAT = '#,##0';

const THIN_BORDER: Partial<ExcelJS.Borders> = (() => {
  const side: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_COLOR } };
  return { top: side, left: side, bottom: side, right: side };
})();
const CENTER_ALIGN: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle' };

function styleUniformRow(row: ExcelJS.Row, opts: { bold: boolean; color: string; fill: string; numericCols: number[] }) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 10, bold: opts.bold, color: { argb: opts.color } };
    cell.alignment = CENTER_ALIGN;
    cell.border = THIN_BORDER;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    if (opts.numericCols.includes(colNumber)) cell.numFmt = NUMBER_FORMAT;
  });
}

function styleShopRow(row: ExcelJS.Row, leaderColIndex: number, numericCols: number[]) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 10, bold: colNumber === leaderColIndex, color: { argb: BLACK } };
    cell.alignment = CENTER_ALIGN;
    cell.border = THIN_BORDER;
    if (numericCols.includes(colNumber)) cell.numFmt = NUMBER_FORMAT;
  });
}

function buildSheet(workbook: ExcelJS.Workbook, name: string, view: StagnantViewResult, hasLine: boolean) {
  const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });

  const headers = hasLine
    ? ['Line', 'Leader', 'Shop Name', 'Company Balance', 'Balance Inside', 'SDP', 'Settlement', 'Shops / Days', 'Recovered']
    : ['Leader', 'Shop Name', 'Company Balance', 'Balance Inside', 'SDP', 'Settlement', 'Shops / Days', 'Recovered'];
  const numericCols = hasLine ? [4, 5, 6, 7, 8, 9] : [3, 4, 5, 6, 7, 8];
  const leaderColIndex = hasLine ? 2 : 1;

  worksheet.columns = headers.map(() => ({ width: 20 }));

  styleUniformRow(worksheet.addRow(headers), { bold: true, color: WHITE, fill: NAVY, numericCols: [] });

  for (const leader of view.leaders) {
    const leaderValues = hasLine
      ? [null, leader.leader, null, leader.companyBalance, leader.balanceInside, leader.sdp, leader.settlementToday, leader.shopCount, leader.recovered]
      : [leader.leader, null, leader.companyBalance, leader.balanceInside, leader.sdp, leader.settlementToday, leader.shopCount, leader.recovered];
    styleUniformRow(worksheet.addRow(leaderValues), { bold: true, color: BLACK, fill: GRAY, numericCols });

    for (const shop of leader.shops) {
      const shopValues = hasLine
        ? [shop.line === 'cashout' ? 'Cashout' : 'Send Money', leader.leader, shop.shopName, shop.companyBalance, shop.balanceInside, shop.sdp, shop.settlementToday, shop.noDataStreakDays, shop.recovered]
        : [leader.leader, shop.shopName, shop.companyBalance, shop.balanceInside, shop.sdp, shop.settlementToday, shop.noDataStreakDays, shop.recovered];
      styleShopRow(worksheet.addRow(shopValues), leaderColIndex, numericCols);
    }
  }

  const totalValues = hasLine
    ? [null, 'TOTAL', null, view.totals.companyBalance, view.totals.balanceInside, view.totals.sdp, view.totals.settlementToday, view.totals.shopCount, view.totals.recovered]
    : ['TOTAL', null, view.totals.companyBalance, view.totals.balanceInside, view.totals.sdp, view.totals.settlementToday, view.totals.shopCount, view.totals.recovered];
  styleUniformRow(worksheet.addRow(totalValues), { bold: true, color: WHITE, fill: NAVY, numericCols });
}

export async function buildStagnantBalanceWorkbook(views: StagnantAllViews): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  buildSheet(workbook, 'Cashout', views.cashout, false);
  buildSheet(workbook, 'Send Money', views.sendmoney, false);
  buildSheet(workbook, 'Group Total', views.group, true);
  return workbook;
}

// Asia/Manila business time — same reasoning as discrepancySummaryExport.ts's
// own header comment (explicit Intl timeZone, not runtime-local getters).
function manilaFilenameParts(date: Date): { y: string; m: string; d: string; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

export function stagnantBalanceExportFilename(date: Date = new Date()): string {
  const { y, m, d, hh, mm } = manilaFilenameParts(date);
  return `Stagnant_Balances_${y}-${m}-${d}_${hh}${mm}.xlsx`;
}

export async function downloadStagnantBalanceExport(views: StagnantAllViews): Promise<void> {
  const workbook = await buildStagnantBalanceWorkbook(views);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = stagnantBalanceExportFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
