import { google, Auth } from 'googleapis';
import { fetchRange } from './googleSheets';

// "Wallet Status" — a dedicated sheet tab holding manually-set, cross-device
// per-shop values (Deposit enabled?, Withdrawal enabled?, Priority, and the
// standalone Active/Inactive/Suspended status field) that don't exist
// anywhere else in the spreadsheet. Sparse by design: only shops a staff
// member has actually touched get a row — everyone else falls back to the
// defaults below. Same column-block-per-product convention as "Estimated
// Opening" (see app/lib/estimatedOpening.ts): Cashout in A-E, Send Money in
// F-J, one blank column between them.
const SHEET_TITLE = 'Wallet Status';

const CASHOUT_START_COL = 'A';
const CASHOUT_END_COL = 'E';
const SENDMONEY_START_COL = 'F';
const SENDMONEY_END_COL = 'J';

export type DepositWithdrawal = 'Yes' | 'No';
export type Priority = 'Low' | 'Normal' | 'High';
// '' = never set — a real, displayable state ("—"), not a default to fall
// back through like Deposit/Withdrawal/Priority above; per the inline-edit
// spec, an unset row shows "—" and only becomes one of the 3 real values
// once a staff member explicitly saves one.
export type WalletStatusValue = 'Active' | 'Inactive' | 'Suspended' | '';
export type WalletStatusField = 'deposit' | 'withdrawal' | 'priority' | 'walletStatus';

export type WalletStatusEntry = {
  deposit: DepositWithdrawal;
  withdrawal: DepositWithdrawal;
  priority: Priority;
  walletStatus: WalletStatusValue;
};

export const DEFAULT_WALLET_STATUS_ENTRY: WalletStatusEntry = {
  deposit: 'No',
  withdrawal: 'No',
  priority: 'Normal',
  walletStatus: '',
};

// Full read-write scope — separate from app/lib/googleSheets.ts's read-only
// client, same reasoning as app/lib/estimatedOpening.ts's own isolated
// write client.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _auth: Auth.JWT | null = null;

function getAuthClient(): Auth.JWT {
  if (_auth) return _auth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error(
      'Missing Google service account credentials. ' +
      'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env.local.'
    );
  }

  _auth = new google.auth.JWT({ email, key: privateKey, scopes: SCOPES });
  return _auth;
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('Missing GOOGLE_SHEET_ID in .env.local.');
  return id;
}

async function ensureSheetExists(sheetsApi: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === SHEET_TITLE);
  if (exists) return;

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
    },
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${CASHOUT_START_COL}1:${CASHOUT_END_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Shop Name', 'Deposit', 'Withdrawal', 'Priority', 'Wallet Status']] },
  });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${SENDMONEY_START_COL}1:${SENDMONEY_END_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Shop Name', 'Deposit', 'Withdrawal', 'Priority', 'Wallet Status']] },
  });
}

function normalizeDepositWithdrawal(raw: string): DepositWithdrawal {
  return raw.trim().toLowerCase() === 'yes' ? 'Yes' : 'No';
}

function normalizePriority(raw: string): Priority {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'high') return 'High';
  if (trimmed === 'low') return 'Low';
  return 'Normal';
}

function normalizeWalletStatusValue(raw: string): WalletStatusValue {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'active') return 'Active';
  if (trimmed === 'inactive') return 'Inactive';
  if (trimmed === 'suspended') return 'Suspended';
  return '';
}

async function readWalletStatus(startCol: string, endCol: string): Promise<Map<string, WalletStatusEntry>> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${startCol}2:${endCol}20000`);
  } catch {
    return new Map();
  }

  const entries = new Map<string, WalletStatusEntry>();
  rows.forEach((row) => {
    const shopName = (row[0] ?? '').trim();
    if (!shopName) return;
    entries.set(shopName.toUpperCase(), {
      deposit: normalizeDepositWithdrawal(row[1] ?? ''),
      withdrawal: normalizeDepositWithdrawal(row[2] ?? ''),
      priority: normalizePriority(row[3] ?? ''),
      walletStatus: normalizeWalletStatusValue(row[4] ?? ''),
    });
  });

  return entries;
}

export async function readCashoutWalletStatus(): Promise<Map<string, WalletStatusEntry>> {
  return readWalletStatus(CASHOUT_START_COL, CASHOUT_END_COL);
}

export async function readSendMoneyWalletStatus(): Promise<Map<string, WalletStatusEntry>> {
  return readWalletStatus(SENDMONEY_START_COL, SENDMONEY_END_COL);
}

// Finds the shop's existing row and overwrites just the one changed field,
// preserving its other two fields as-is. A shop with no row yet gets a new
// one appended, with the untouched fields set to their defaults — never a
// full-table rewrite (unlike Estimated Opening's own upload, which always
// replaces everything; this is a live, single-cell edit instead).
async function updateWalletStatusField(
  startCol: string,
  endCol: string,
  shopName: string,
  field: WalletStatusField,
  value: string
): Promise<void> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const rows = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}2:${endCol}20000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = rows.data.values ?? [];

  const normalizedShop = shopName.trim().toUpperCase();
  const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);

  const fieldColOffset = field === 'deposit' ? 1 : field === 'withdrawal' ? 2 : field === 'priority' ? 3 : 4;
  const colLetters = Array.from({ length: 5 }, (_, i) => String.fromCharCode(startCol.charCodeAt(0) + i));

  if (rowOffset !== -1) {
    const sheetRow = rowOffset + 2; // data starts at row 2
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!${colLetters[fieldColOffset]}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
    return;
  }

  const sheetRow = existingRows.length + 2;
  const newRow = [shopName, 'No', 'No', 'Normal', ''];
  newRow[fieldColOffset] = value;
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}${sheetRow}:${endCol}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });
}

export async function updateCashoutWalletStatusField(shopName: string, field: WalletStatusField, value: string): Promise<void> {
  return updateWalletStatusField(CASHOUT_START_COL, CASHOUT_END_COL, shopName, field, value);
}

export async function updateSendMoneyWalletStatusField(shopName: string, field: WalletStatusField, value: string): Promise<void> {
  return updateWalletStatusField(SENDMONEY_START_COL, SENDMONEY_END_COL, shopName, field, value);
}
