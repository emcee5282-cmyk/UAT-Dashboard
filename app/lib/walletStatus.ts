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

// Remarks — a separate, independent sparse table (own Shop Name key column,
// not row-aligned with the Deposit/Withdrawal/Priority/Wallet Status block
// above): a shop can get a remark without ever touching Priority/Wallet
// Status, and vice versa. Placed past column J (not inserted before it) so
// the existing A-E/F-J blocks — already holding real production data — are
// never disturbed. One blank separator column before each, same convention
// as app/lib/estimatedOpening.ts's own block spacing.
const CASHOUT_REMARKS_START_COL = 'L';
const CASHOUT_REMARKS_END_COL = 'O';
const SENDMONEY_REMARKS_START_COL = 'Q';
const SENDMONEY_REMARKS_END_COL = 'T';
// No auth system exists in this app — same static label convention as
// app/lib/estimatedOpening.ts's own IMPORTED_BY.
const REMARK_UPDATED_BY = 'Operations Admin';

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

// A shop's internal note — independent of Wallet Status/Priority above, per
// explicit instruction: changing Wallet Status must never overwrite or
// remove a Remark. `updatedAt` is stored as an ISO string (round-trips
// exactly; display formatting happens client-side).
export type WalletRemarkEntry = {
  remark: string;
  updatedBy: string;
  updatedAt: string;
};

export const DEFAULT_WALLET_REMARK_ENTRY: WalletRemarkEntry = {
  remark: '',
  updatedBy: '',
  updatedAt: '',
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

export type WalletStatusBulkUpdate = { shopName: string; priority?: Priority; remark?: string };

// Bulk Edit's own write path — deliberately NOT N parallel calls into
// updateWalletStatusField/updateWalletRemark above. Each of those does a
// full-range read to find its one row before writing a single cell; firing
// that per selected shop (Priority is only one of up to 2 bulk fields)
// would mean up to 2x the selection count of full-sheet reads landing on
// Google Sheets concurrently from one Bulk Edit click, which is exactly the
// kind of burst that trips Sheets API rate limits. Instead this reads the
// Priority block and the Remarks block ONCE EACH (only if that field is
// actually part of the bulk edit), resolves every shop's row offset (or
// appends past the end for shops with no existing row) against that single
// snapshot, and writes every changed cell/row in ONE values.batchUpdate
// call. New rows appended within the same batch get sequential offsets
// past the snapshot's own length — safe because nothing else can write to
// this sheet between the read and the batchUpdate inside one request.
async function updateWalletStatusBulk(
  statusStartCol: string,
  statusEndCol: string,
  remarksStartCol: string,
  remarksEndCol: string,
  updates: WalletStatusBulkUpdate[]
): Promise<{ updatedBy: string; updatedAt: string }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const priorityUpdates = updates.filter((u) => u.priority !== undefined);
  const remarkUpdates = updates.filter((u) => u.remark !== undefined);

  const data: { range: string; values: string[][] }[] = [];
  const updatedBy = REMARK_UPDATED_BY;
  const updatedAt = new Date().toISOString();

  if (priorityUpdates.length > 0) {
    const rows = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!${statusStartCol}2:${statusEndCol}20000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const existingRows = rows.data.values ?? [];
    const colLetters = Array.from({ length: 5 }, (_, i) => String.fromCharCode(statusStartCol.charCodeAt(0) + i));
    let nextNewRow = existingRows.length + 2;
    for (const u of priorityUpdates) {
      const normalizedShop = u.shopName.trim().toUpperCase();
      const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);
      if (rowOffset !== -1) {
        const sheetRow = rowOffset + 2; // data starts at row 2
        data.push({ range: `${SHEET_TITLE}!${colLetters[3]}${sheetRow}`, values: [[u.priority as string]] });
      } else {
        const sheetRow = nextNewRow++;
        const newRow = [u.shopName, 'No', 'No', u.priority as string, ''];
        data.push({ range: `${SHEET_TITLE}!${statusStartCol}${sheetRow}:${statusEndCol}${sheetRow}`, values: [newRow] });
      }
    }
  }

  if (remarkUpdates.length > 0) {
    await ensureRemarksHeader(sheetsApi, spreadsheetId, remarksStartCol, remarksEndCol);
    const rows = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!${remarksStartCol}2:${remarksEndCol}20000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const existingRows = rows.data.values ?? [];
    let nextNewRow = existingRows.length + 2;
    for (const u of remarkUpdates) {
      const normalizedShop = u.shopName.trim().toUpperCase();
      const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);
      const sheetRow = rowOffset !== -1 ? rowOffset + 2 : nextNewRow++;
      const newRow = [u.shopName, u.remark as string, updatedBy, updatedAt];
      data.push({ range: `${SHEET_TITLE}!${remarksStartCol}${sheetRow}:${remarksEndCol}${sheetRow}`, values: [newRow] });
    }
  }

  if (data.length > 0) {
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }

  return { updatedBy, updatedAt };
}

export async function updateCashoutWalletStatusBulk(updates: WalletStatusBulkUpdate[]): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletStatusBulk(CASHOUT_START_COL, CASHOUT_END_COL, CASHOUT_REMARKS_START_COL, CASHOUT_REMARKS_END_COL, updates);
}

export async function updateSendMoneyWalletStatusBulk(updates: WalletStatusBulkUpdate[]): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletStatusBulk(SENDMONEY_START_COL, SENDMONEY_END_COL, SENDMONEY_REMARKS_START_COL, SENDMONEY_REMARKS_END_COL, updates);
}

// Remarks — own independent block (see column constants above). Own Shop
// Name key column (col 0 of the block) since this table's row set doesn't
// necessarily match the Deposit/Withdrawal/Priority/Wallet Status block's.
async function readWalletRemarks(startCol: string, endCol: string): Promise<Map<string, WalletRemarkEntry>> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${startCol}2:${endCol}20000`);
  } catch {
    return new Map();
  }

  const entries = new Map<string, WalletRemarkEntry>();
  rows.forEach((row) => {
    const shopName = (row[0] ?? '').trim();
    if (!shopName) return;
    entries.set(shopName.toUpperCase(), {
      remark: (row[1] ?? '').trim(),
      updatedBy: (row[2] ?? '').trim(),
      updatedAt: (row[3] ?? '').trim(),
    });
  });

  return entries;
}

export async function readCashoutWalletRemarks(): Promise<Map<string, WalletRemarkEntry>> {
  return readWalletRemarks(CASHOUT_REMARKS_START_COL, CASHOUT_REMARKS_END_COL);
}

export async function readSendMoneyWalletRemarks(): Promise<Map<string, WalletRemarkEntry>> {
  return readWalletRemarks(SENDMONEY_REMARKS_START_COL, SENDMONEY_REMARKS_END_COL);
}

// Writes the header row for a Remarks block unconditionally (idempotent
// overwrite, harmless if already present) — the "Wallet Status" sheet tab
// already exists in production today, so ensureSheetExists' own bootstrap
// (which only fires on first-ever tab creation) never sees these columns.
async function ensureRemarksHeader(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  startCol: string,
  endCol: string
): Promise<void> {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}1:${endCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Shop Name', 'Remark', 'Updated By', 'Updated At']] },
  });
}

// Finds the shop's existing Remarks row and overwrites all 3 value cells
// together (Remark/Updated By/Updated At always change as one unit on
// Save — unlike updateWalletStatusField's single-field-at-a-time edits).
// Appends a new row if the shop has none yet. An empty-string remark is a
// valid, intentional value (clearing a remark back out), not skipped.
async function updateWalletRemark(startCol: string, endCol: string, shopName: string, remark: string): Promise<{ updatedBy: string; updatedAt: string }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);
  await ensureRemarksHeader(sheetsApi, spreadsheetId, startCol, endCol);

  const rows = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}2:${endCol}20000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = rows.data.values ?? [];

  const normalizedShop = shopName.trim().toUpperCase();
  const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);

  const updatedBy = REMARK_UPDATED_BY;
  const updatedAt = new Date().toISOString();
  const newRow = [shopName, remark, updatedBy, updatedAt];

  if (rowOffset !== -1) {
    const sheetRow = rowOffset + 2; // data starts at row 2
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!${startCol}${sheetRow}:${endCol}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [newRow] },
    });
    return { updatedBy, updatedAt };
  }

  const sheetRow = existingRows.length + 2;
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}${sheetRow}:${endCol}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });
  return { updatedBy, updatedAt };
}

export async function updateCashoutWalletRemark(shopName: string, remark: string): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletRemark(CASHOUT_REMARKS_START_COL, CASHOUT_REMARKS_END_COL, shopName, remark);
}

export async function updateSendMoneyWalletRemark(shopName: string, remark: string): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletRemark(SENDMONEY_REMARKS_START_COL, SENDMONEY_REMARKS_END_COL, shopName, remark);
}

export type MergedWalletStatusEntry = WalletStatusEntry & WalletRemarkEntry;

// Combines the two independent maps into one per-shop object — additive
// merge over the union of shop keys, so a shop present in only one side
// still gets the other side's defaults instead of being dropped.
export function mergeWalletStatusAndRemarks(
  status: Map<string, WalletStatusEntry>,
  remarks: Map<string, WalletRemarkEntry>
): Record<string, MergedWalletStatusEntry> {
  const merged: Record<string, MergedWalletStatusEntry> = {};
  const keys = new Set([...status.keys(), ...remarks.keys()]);
  keys.forEach((key) => {
    merged[key] = {
      ...DEFAULT_WALLET_STATUS_ENTRY,
      ...(status.get(key) ?? {}),
      ...DEFAULT_WALLET_REMARK_ENTRY,
      ...(remarks.get(key) ?? {}),
    };
  });
  return merged;
}
