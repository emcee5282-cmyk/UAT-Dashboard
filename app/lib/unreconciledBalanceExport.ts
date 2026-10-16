// Excel export for Pending Balance's "Unreconciled Balance" tab — same
// exceljs cell-styling convention as discrepancySummaryExport.ts (this
// feature's own sibling tab), reused byte-for-byte: Calibri 10, navy
// #1F4E78 header/Total rows, thin #BFBFBF borders, #,##0 number format,
// 20-wide columns, header row frozen.
//
// Takes the already-aggregated views the page itself renders
// (UnreconciledAllViews from unreconciledBalanceAggregate.ts) — no
// re-querying, and always exports every leader regardless of which card is
// selected or what's currently typed into the search box.
import ExcelJS from 'exceljs';
import type { UnreconciledAllViews, UnreconciledLeaderRow } from './unreconciledBalanceAggregate';
import { sumUnreconciledRows } from './unreconciledBalanceAggregate';

const WHITE = 'FFFFFFFF';
const BLACK = 'FF000000';
const NAVY = 'FF1F4E78';
const BORDER_COLOR = 'FFBFBFBF';
const NUMBER_FORMAT = '#,##0';

const THIN_BORDER: Partial<ExcelJS.Borders> = (() => {
  const side: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_COLOR } };
  return { top: side, left: side, bottom: side, right: side };
})();
const CENTER_ALIGN: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle' };

function styleUniformRow(row: ExcelJS.Row, opts: { bold: boolean; color: string; fill: string | null; numericCols: number[] }) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 10, bold: opts.bold, color: { argb: opts.color } };
    cell.alignment = CENTER_ALIGN;
    cell.border = THIN_BORDER;
    if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    if (opts.numericCols.includes(colNumber)) cell.numFmt = NUMBER_FORMAT;
  });
}

const HEADERS = ['Group Leader', 'Total Company Balance', 'Total Wallet Balance', 'Total Discrepancy', 'Total SDP', 'Withheld Balance'];
const NUMERIC_COLS = [2, 3, 4, 5, 6];

function rowValues(leader: Omit<UnreconciledLeaderRow, 'shopCount'> & { leader: string }): (string | number)[] {
  return [leader.leader, leader.companyBalance, leader.balanceInside, leader.agentWithdrawal, leader.sdp, leader.sdpVsBalance];
}

function buildSheet(workbook: ExcelJS.Workbook, name: string, leaders: UnreconciledLeaderRow[]) {
  const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = HEADERS.map(() => ({ width: 20 }));

  styleUniformRow(worksheet.addRow(HEADERS), { bold: true, color: WHITE, fill: NAVY, numericCols: [] });

  for (const leader of leaders) {
    styleUniformRow(worksheet.addRow(rowValues(leader)), { bold: false, color: BLACK, fill: null, numericCols: NUMERIC_COLS });
  }

  const totals = sumUnreconciledRows(leaders);
  styleUniformRow(worksheet.addRow(['Total', totals.companyBalance, totals.balanceInside, totals.agentWithdrawal, totals.sdp, totals.sdpVsBalance]), {
    bold: true,
    color: WHITE,
    fill: NAVY,
    numericCols: NUMERIC_COLS,
  });
}

export async function buildUnreconciledBalanceWorkbook(views: UnreconciledAllViews): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  buildSheet(workbook, 'Cashout', views.cashout);
  buildSheet(workbook, 'Send Money', views.sendmoney);
  buildSheet(workbook, 'Group Total', views.group);
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

export function unreconciledBalanceExportFilename(date: Date = new Date()): string {
  const { y, m, d, hh, mm } = manilaFilenameParts(date);
  return `Unreconciled_Balance_${y}-${m}-${d}_${hh}${mm}.xlsx`;
}

export async function downloadUnreconciledBalanceExport(views: UnreconciledAllViews): Promise<void> {
  const workbook = await buildUnreconciledBalanceWorkbook(views);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = unreconciledBalanceExportFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
