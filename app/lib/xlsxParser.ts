import * as XLSX from 'xlsx';

// Thin, reusable wrapper around the `xlsx` library — every bulk-import
// flow (Settlement today; other modules later) needs the exact same
// "read the first sheet as a 2D array" step, so it lives here once instead
// of being re-typed per module. Splitting header from data rows is left to
// each module's own mapper (see mapSettlementRows below) — the real
// Settlement template has a title row ABOVE its actual header row, so a
// naive "row 0 is always the header" assumption doesn't hold in general.
export type ParsedWorkbook = {
  allRows: (string | number)[][];
};

export async function parseWorkbookFile(file: File): Promise<ParsedWorkbook> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const allRows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  if (allRows.length === 0) {
    throw new Error('The file appears to be empty.');
  }
  return { allRows };
}

// Settlement's own column contract — matches the official template
// (public/templates/settlement-template.xlsx), which has its own real-world
// naming ("To Agent" for the agent column, "Type" for the remarks column —
// the same convention already used by the live "AG BD STLM + TOPUP" sheet
// this app reads elsewhere) and a title row before the actual header row.
// Both "Agent Name"/"To Agent" and "Remarks"/"Type" are accepted so a
// future template revision using the more literal names still resolves.
export type SettlementImportRow = {
  row: number; // 1-based, matching the row's real position in the spreadsheet
  brand: string;
  agentName: string;
  wallet: string;
  amount: string;
  remarks: string;
  date: string;
};

// Excel's date epoch is 1899-12-30 (the historical leap-year bug is
// intentionally preserved — this constant matches how Excel itself counts
// days). Exported so settlementValidation.ts's parseImportDate reuses this
// exact same math instead of keeping its own duplicate copy.
export function excelSerialToDate(serial: number): Date {
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(utcMs);
}

// A date-formatted Excel cell comes through sheet_to_json as its raw
// numeric serial (e.g. 46225), not the "7/22/2026" the user actually sees
// in Excel — normalized here, at the parsing boundary, so every downstream
// consumer (validation, the error table's "Invalid Value" column, the Edit
// Row modal) only ever sees a plain "M/D/YYYY" string and never has to
// know Excel dates are numbers internally.
function normalizeDateCell(raw: string | number | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const serial = parseFloat(trimmed);
    if (serial > 20000 && serial < 90000) {
      const date = excelSerialToDate(serial);
      return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    }
  }
  return trimmed;
}

function findHeaderRowIndex(allRows: (string | number)[][]): number {
  return allRows.findIndex((row) =>
    row.some((cell) => String(cell ?? '').trim().toLowerCase() === 'brand')
  );
}

export function mapSettlementRows(parsed: ParsedWorkbook): SettlementImportRow[] {
  const headerRowIndex = findHeaderRowIndex(parsed.allRows);
  if (headerRowIndex === -1) {
    throw new Error('Could not find a "Brand" column — this doesn\'t look like the Settlement template.');
  }
  const headerRow = parsed.allRows[headerRowIndex];
  const dataRows = parsed.allRows.slice(headerRowIndex + 1);
  const normalizedHeader = headerRow.map((h) => String(h ?? '').trim().toLowerCase());
  const colIndex = (...names: string[]) => {
    for (const name of names) {
      const found = normalizedHeader.indexOf(name);
      if (found !== -1) return found;
    }
    return -1;
  };
  const indices = {
    brand: colIndex('brand'),
    agentName: colIndex('agent name', 'to agent'),
    wallet: colIndex('wallet'),
    amount: colIndex('amount'),
    remarks: colIndex('remarks', 'type'),
    date: colIndex('date'),
  };

  return dataRows
    .filter((cols) => cols.some((cell) => String(cell ?? '').trim() !== ''))
    .map((cols, i) => ({
      row: headerRowIndex + i + 2, // +1 for 0-index, +1 to point past the header row itself
      brand: String(cols[indices.brand] ?? '').trim(),
      agentName: String(cols[indices.agentName] ?? '').trim(),
      wallet: String(cols[indices.wallet] ?? '').trim(),
      amount: String(cols[indices.amount] ?? '').trim(),
      remarks: String(cols[indices.remarks] ?? '').trim(),
      date: normalizeDateCell(cols[indices.date]),
    }));
}

// Top Up's own column contract (public/templates/topup-template.xlsx: Brand,
// Agent, Amount, Wallet, Type, Date). Deliberately a separate type from
// SettlementImportRow even though the two shapes are similar — Top Up's
// "Type" is a closed-set fixed literal per product ("BUNDLE TRANSFER" /
// "INTERNAL TRANSFER"), not Settlement's free-text "Remarks", so it gets its
// own field name and its own hard-error validation (see
// topupValidation.ts's checkTypeField) instead of aliasing onto `remarks`.
export type TopUpImportRow = {
  row: number;
  brand: string;
  agentName: string;
  wallet: string;
  amount: string;
  type: string;
  date: string;
};

export function mapTopUpRows(parsed: ParsedWorkbook): TopUpImportRow[] {
  const headerRowIndex = findHeaderRowIndex(parsed.allRows);
  if (headerRowIndex === -1) {
    throw new Error('Could not find a "Brand" column — this doesn\'t look like the Top Up template.');
  }
  const headerRow = parsed.allRows[headerRowIndex];
  const dataRows = parsed.allRows.slice(headerRowIndex + 1);
  const normalizedHeader = headerRow.map((h) => String(h ?? '').trim().toLowerCase());
  const colIndex = (...names: string[]) => {
    for (const name of names) {
      const found = normalizedHeader.indexOf(name);
      if (found !== -1) return found;
    }
    return -1;
  };
  const indices = {
    brand: colIndex('brand'),
    agentName: colIndex('agent name', 'to agent', 'agent'),
    wallet: colIndex('wallet'),
    amount: colIndex('amount'),
    type: colIndex('type'),
    date: colIndex('date'),
  };

  return dataRows
    .filter((cols) => cols.some((cell) => String(cell ?? '').trim() !== ''))
    .map((cols, i) => ({
      row: headerRowIndex + i + 2,
      brand: String(cols[indices.brand] ?? '').trim(),
      agentName: String(cols[indices.agentName] ?? '').trim(),
      wallet: String(cols[indices.wallet] ?? '').trim(),
      amount: String(cols[indices.amount] ?? '').trim(),
      type: String(cols[indices.type] ?? '').trim(),
      date: normalizeDateCell(cols[indices.date]),
    }));
}

// Opening Balance's own column contract — a static roster snapshot, not a
// per-transaction record, so neither official template
// (public/templates/opening-cashout-template.xlsx: Agent name/Opening
// Bal./SDP/Leader; opening-sendmoney-template.xlsx: Wallet Name/Opening
// Bal./SDP/TL/Total DP/Total WD) has a "Brand" column at all — the "brand"
// anchor findHeaderRowIndex() uses doesn't apply here, so this gets its own
// header-row finder anchored on "sdp" instead (present, identically named,
// in both templates; absent from Settlement/Top Up's). Total DP/Total WD
// (Send Money template only) are ignored — neither Opening page's own row
// model includes them.
function findOpeningHeaderRowIndex(allRows: (string | number)[][]): number {
  return allRows.findIndex((row) =>
    row.some((cell) => String(cell ?? '').trim().toLowerCase() === 'sdp')
  );
}

export type OpeningImportRow = {
  row: number;
  agentName: string;
  leader: string;
  openingBalance: string;
  sdp: string;
};

export function mapOpeningRows(parsed: ParsedWorkbook): OpeningImportRow[] {
  const headerRowIndex = findOpeningHeaderRowIndex(parsed.allRows);
  if (headerRowIndex === -1) {
    throw new Error('Could not find an "SDP" column — this doesn\'t look like the Opening Balance template.');
  }
  const headerRow = parsed.allRows[headerRowIndex];
  const dataRows = parsed.allRows.slice(headerRowIndex + 1);
  const normalizedHeader = headerRow.map((h) => String(h ?? '').trim().toLowerCase());
  const colIndex = (...names: string[]) => {
    for (const name of names) {
      const found = normalizedHeader.indexOf(name);
      if (found !== -1) return found;
    }
    return -1;
  };
  const indices = {
    agentName: colIndex('agent name', 'wallet name'),
    leader: colIndex('leader', 'tl'),
    openingBalance: colIndex('opening bal.', 'opening bal', 'opening balance'),
    sdp: colIndex('sdp'),
  };

  return dataRows
    .filter((cols) => cols.some((cell) => String(cell ?? '').trim() !== ''))
    .map((cols, i) => ({
      row: headerRowIndex + i + 2,
      agentName: String(cols[indices.agentName] ?? '').trim(),
      leader: String(cols[indices.leader] ?? '').trim(),
      openingBalance: String(cols[indices.openingBalance] ?? '').trim(),
      sdp: String(cols[indices.sdp] ?? '').trim(),
    }));
}
