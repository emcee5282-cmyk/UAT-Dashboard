// Excel export for Daily Txn Entry's "Discrepancy Summary" tab — this file
// only, scoped to this tab (the Balance tab's own Export button and every
// other export in the app stay on the plain `xlsx`/SheetJS writer they
// already use; neither is touched here).
//
// Uses `exceljs` (not the installed `xlsx` package) because this export
// needs real cell styling — fills, bold, borders, number formats, frozen
// panes — which SheetJS's free community build cannot write at all. Styling
// values below were read directly out of the reference file's own XML
// (fonts.xml/styles.xml), not eyeballed from a screenshot, so they should
// match it byte-for-byte when opened in Excel.
//
// Takes the SAME already-aggregated views the page itself renders
// (DiscrepancySummaryAllViews from discrepancySummaryAggregate.ts) — no
// re-querying or re-calculating, and the export always contains every
// leader/shop regardless of which rows are expanded or which card is
// selected on the page.
import ExcelJS from 'exceljs';
import type { DiscrepancySummaryAllViews, DiscrepancySummaryViewResult } from './discrepancySummaryAggregate';

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

// Shop rows have no fill, and only the Leader column is bold (not the whole
// row), so they get their own per-cell pass instead of styleUniformRow.
function styleShopRow(row: ExcelJS.Row, leaderColIndex: number, numericCols: number[]) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 10, bold: colNumber === leaderColIndex, color: { argb: BLACK } };
    cell.alignment = CENTER_ALIGN;
    cell.border = THIN_BORDER;
    if (numericCols.includes(colNumber)) cell.numFmt = NUMBER_FORMAT;
  });
}

function buildSheet(workbook: ExcelJS.Workbook, name: string, view: DiscrepancySummaryViewResult, hasLine: boolean) {
  const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });

  const headers = hasLine
    ? ['Line', 'Leader', 'Shop Name', 'SDP', 'Company Balance', 'Balance Inside', 'Agent Withdrawal']
    : ['Leader', 'Shop Name', 'SDP', 'Company Balance', 'Balance Inside', 'Agent Withdrawal'];
  const numericCols = hasLine ? [4, 5, 6, 7] : [3, 4, 5, 6];
  const leaderColIndex = hasLine ? 2 : 1;

  worksheet.columns = headers.map(() => ({ width: 20 }));

  styleUniformRow(worksheet.addRow(headers), { bold: true, color: WHITE, fill: NAVY, numericCols: [] });

  for (const leader of view.leaders) {
    const leaderValues = hasLine
      ? [null, leader.leader, null, leader.sdp, leader.companyBalance, leader.balanceInside, leader.agentWithdrawal]
      : [leader.leader, null, leader.sdp, leader.companyBalance, leader.balanceInside, leader.agentWithdrawal];
    styleUniformRow(worksheet.addRow(leaderValues), { bold: true, color: BLACK, fill: GRAY, numericCols });

    for (const shop of leader.shops) {
      const shopValues = hasLine
        ? [shop.line === 'cashout' ? 'Cashout' : 'Send Money', leader.leader, shop.shopName, shop.sdp, shop.companyBalance, shop.balanceInside, shop.agentWithdrawal]
        : [leader.leader, shop.shopName, shop.sdp, shop.companyBalance, shop.balanceInside, shop.agentWithdrawal];
      styleShopRow(worksheet.addRow(shopValues), leaderColIndex, numericCols);
    }
  }

  const totalValues = hasLine
    ? [null, 'TOTAL', null, view.totals.sdp, view.totals.companyBalance, view.totals.balanceInside, view.totals.agentWithdrawal]
    : ['TOTAL', null, view.totals.sdp, view.totals.companyBalance, view.totals.balanceInside, view.totals.agentWithdrawal];
  styleUniformRow(worksheet.addRow(totalValues), { bold: true, color: WHITE, fill: NAVY, numericCols });
}

export async function buildDiscrepancySummaryWorkbook(views: DiscrepancySummaryAllViews): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  buildSheet(workbook, 'Cashout', views.cashout, false);
  buildSheet(workbook, 'Send Money', views.sendmoney, false);
  buildSheet(workbook, 'Group Total', views.group, true);
  return workbook;
}

// Asia/Manila business time, via explicit Intl timeZone rather than the
// runtime's own local getters — same reasoning as app/lib/businessDate.ts's
// own header comment: relying on local getters silently goes wrong whenever
// the runtime isn't itself set to Manila time.
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

export function discrepancySummaryExportFilename(date: Date = new Date()): string {
  const { y, m, d, hh, mm } = manilaFilenameParts(date);
  return `Discrepancy_Summary_${y}-${m}-${d}_${hh}${mm}.xlsx`;
}

export async function downloadDiscrepancySummaryExport(views: DiscrepancySummaryAllViews): Promise<void> {
  const workbook = await buildDiscrepancySummaryWorkbook(views);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = discrepancySummaryExportFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
