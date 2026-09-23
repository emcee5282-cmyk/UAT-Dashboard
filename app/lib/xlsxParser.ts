import * as XLSX from 'xlsx';
import { normalizeOpeningAgentName, extractOpeningWalletTypeSuffix, extractRealShopName, extractSendMoneyShopName } from './realShopName';

// Settlement/Top Up's own "Agent"/"To Agent" cell mostly already carries a
// clean bare code, but — confirmed live via DRUID004 (2 real ₱50,000
// settlements landed on a stale duplicate agent instead of the real, active
// shop) — the SAME raw per-wallet account text Opening/Balance Limit both
// already handle (e.g. "N-M1AG-S8-DRUID004-BK") sometimes appears here too.
// Unlike importOpeningFile's own agentName, this pipeline has no roster
// available at parse time to decide "does the extracted code actually
// match a real shop" — so instead of Opening's stricter contract, this
// tries the same extraction Balance Limit already trusts and ONLY uses it
// when it produces something non-empty; a cell extraction can't resolve
// (blank result) keeps the ORIGINAL raw text unchanged, exactly matching
// today's behavior — this can only IMPROVE a currently-broken/ambiguous
// match, never break a currently-working one.
function resolveTransactionAgentName(raw: string, product?: 'cashout' | 'sendmoney'): string {
  const extracted = product === 'sendmoney' ? extractSendMoneyShopName(raw) : extractRealShopName(raw);
  return extracted || raw;
}

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

export function mapSettlementRows(parsed: ParsedWorkbook, product?: 'cashout' | 'sendmoney'): SettlementImportRow[] {
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
      agentName: resolveTransactionAgentName(String(cols[indices.agentName] ?? '').trim(), product),
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

export function mapTopUpRows(parsed: ParsedWorkbook, product?: 'cashout' | 'sendmoney'): TopUpImportRow[] {
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
      agentName: resolveTransactionAgentName(String(cols[indices.agentName] ?? '').trim(), product),
      wallet: String(cols[indices.wallet] ?? '').trim(),
      amount: String(cols[indices.amount] ?? '').trim(),
      type: String(cols[indices.type] ?? '').trim(),
      date: normalizeDateCell(cols[indices.date]),
    }));
}

// Confirmed against both real templates (opening-cashout-template.xlsx,
// opening-sendmoney-template.xlsx): the SDP header cell is plain "SDP",
// nothing exotic. Real uploaded files still occasionally fail this match
// (see mapOpeningRows' "Could not find an SDP column" report) — plain
// .trim() handles ordinary spaces (and even NBSP, part of the ECMAScript
// WhiteSpace set) but NOT zero-width space (U+200B) or a leading BOM
// (U+FEFF), both known artifacts of copy/pasting a sheet from a browser or
// re-saving out of Google Sheets. Stripped here so a header cell that LOOKS
// like plain "SDP" but carries an invisible character still matches.
function normalizeHeaderCell(cell: string | number | undefined): string {
  return String(cell ?? '').replace(/[​﻿]/g, '').trim().toLowerCase();
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
    row.some((cell) => normalizeHeaderCell(cell) === 'sdp')
  );
}

export type OpeningImportRow = {
  row: number;
  agentName: string;
  leader: string;
  openingBalance: string;
  sdp: string;
  // The wallet-type suffix (e.g. "BK") the RAW cell carried before
  // normalizeOpeningAgentName stripped it off agentName below — captured
  // here, at the only place that still has the raw text, so a caller that
  // needs to know WHICH wallet this row belongs to (importOpeningFile's
  // per-wallet Opening Balance write) doesn't have to re-derive it from an
  // already-stripped agentName, where it's gone. null for a Pattern A row
  // (already bare, no suffix to begin with) or an unrecognized brand.
  walletTypeSuffix: string | null;
  // The raw cell text, whitespace-cleaned ONLY — never brand/suffix-
  // stripped. Per explicit instruction: the Opening page must display
  // exactly what the file says (e.g. "N-K1AG-T1-SANGE006-BK"), never the
  // normalized agentName above, which stays reserved for roster matching.
  rawAgentName: string;
};

// Normalizes exactly once, here, at parse time — so every downstream
// consumer (the client-side upload wizard's own preview, AND
// importOpeningFile()'s roster-match lookup AND its new-shop insert) reads
// the SAME already-normalized agentName, instead of two call sites each
// needing to remember to normalize consistently. Cashout-only: Send
// Money's own Opening rows never had this bug (unrelated naming
// convention, its own extractSendMoneyShopName formula, out of scope —
// this fix is scoped to the confirmed Cashout-specific problem only).
export function mapOpeningRows(parsed: ParsedWorkbook, product?: 'cashout' | 'sendmoney'): OpeningImportRow[] {
  const headerRowIndex = findOpeningHeaderRowIndex(parsed.allRows);
  if (headerRowIndex === -1) {
    throw new Error('Could not find an "SDP" column — this doesn\'t look like the Opening Balance template.');
  }
  const headerRow = parsed.allRows[headerRowIndex];
  const dataRows = parsed.allRows.slice(headerRowIndex + 1);
  const normalizedHeader = headerRow.map((h) => normalizeHeaderCell(h));
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
    .map((cols, i) => {
      // Strips ALL whitespace, not just leading/trailing (.trim() alone
      // misses an internal stray space, e.g. "N- M2PS1-BROOK072-NG" instead
      // of "N-M2PS1-BROOK072-NG" — a real, recurring typo in the live
      // roster, confirmed against 28 real agent_code rows). None of the
      // accepted Agent Name formats (openingValidation.ts) ever contain a
      // legitimate space, so this is safe for every row — it only ever
      // "rescues" a name whose sole defect was stray whitespace; a name
      // with any other structural problem still fails validation
      // afterward exactly as before. This is the ONLY cleanup ever applied
      // to rawAgentName below — agentName additionally normalizes on top
      // of this for roster matching, but the raw form itself is never
      // brand/suffix-stripped, per explicit instruction.
      const rawAgentName = String(cols[indices.agentName] ?? '').replace(/\s+/g, '');
      return {
        row: headerRowIndex + i + 2,
        agentName: product === 'cashout' ? normalizeOpeningAgentName(rawAgentName) : rawAgentName,
        leader: String(cols[indices.leader] ?? '').trim(),
        openingBalance: String(cols[indices.openingBalance] ?? '').trim(),
        sdp: String(cols[indices.sdp] ?? '').trim(),
        walletTypeSuffix: product === 'cashout' ? extractOpeningWalletTypeSuffix(rawAgentName) : null,
        rawAgentName,
      };
    });
}
