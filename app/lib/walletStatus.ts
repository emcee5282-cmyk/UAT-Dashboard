import { google, Auth } from 'googleapis';
import { fetchRange } from './googleSheets';

// "Wallet Status" — a dedicated sheet tab holding manually-set, cross-device
// per-shop values (Deposit enabled?, Withdrawal enabled?, Priority, the
// standalone Active/Inactive/Suspended status field, Remarks, and the
// Wallet Settings overrides — Main Reason/Closure Type/Affected Services/
// Minimum Amount Can Take/Balance Limit/Schedule) that don't exist anywhere
// else in the spreadsheet. Sparse by design: only shops a staff member has
// actually touched get a row — everyone else falls back to the defaults
// below.
//
// Column layout (migrated 2026-08-07 — was previously interleaved
// Cashout/Send Money block-by-block; now each product owns one fully
// separated contiguous range, per explicit instruction that the two must
// never mix):
//   Cashout:    A-E status, G-J remarks, L-R overrides   (A-R overall)
//   Send Money: T-X status, Z-AC remarks, AE-AK overrides (T-AK overall)
// One blank separator column before each sub-block, plus a wider gap
// (column S) between the two products' ranges.
const SHEET_TITLE = 'Wallet Status';

const CASHOUT_START_COL = 'A';
const CASHOUT_END_COL = 'E';
const CASHOUT_REMARKS_START_COL = 'G';
const CASHOUT_REMARKS_END_COL = 'J';
const CASHOUT_OVERRIDES_START_COL = 'L';
const CASHOUT_OVERRIDES_END_COL = 'R';

const SENDMONEY_START_COL = 'T';
const SENDMONEY_END_COL = 'X';
const SENDMONEY_REMARKS_START_COL = 'Z';
const SENDMONEY_REMARKS_END_COL = 'AC';
const SENDMONEY_OVERRIDES_START_COL = 'AE';
const SENDMONEY_OVERRIDES_END_COL = 'AK';

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

// Cashout-only. '' = no Main Reason set — a real, displayable "unset"
// state, same convention as WalletStatusValue's own ''.
export type MainReason = 'Closed by Operations' | 'High Running Balance' | 'Reduce as per Leader' | 'Wallet Issue' | 'Blocked by Wallet Office' | 'Others' | '';
export type ClosureType = 'Temporary Close' | 'Permanent Close' | '';
// Descriptive only — per explicit instruction, does NOT touch the wallet's
// real Deposit/Withdrawal capability (still 100% computed from live
// account status, see deriveWalletFlags in app/wallet-status/page.tsx).
export type AffectedService = 'Deposit' | 'Withdrawal';
export type ScheduleOverride = '' | 'Day' | 'Extended' | 'Early Ext.' | '24/7';

export type WalletOverrideEntry = {
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  // null = not set — a real number (including 0) is an explicit staff-
  // entered value. Same null-means-unset convention as
  // balanceLimitOverride below.
  minimumAmountCanTake: number | null;
  // null = not overridden (falls back to the live-computed Available
  // Limit); a number (including 0) is an explicit manual override.
  balanceLimitOverride: number | null;
  scheduleOverride: ScheduleOverride;
};

export const DEFAULT_WALLET_OVERRIDE_ENTRY: WalletOverrideEntry = {
  mainReason: '',
  closureType: '',
  affectedServices: [],
  minimumAmountCanTake: null,
  balanceLimitOverride: null,
  scheduleOverride: '',
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

const MAIN_REASON_VALUES: MainReason[] = ['Closed by Operations', 'High Running Balance', 'Reduce as per Leader', 'Wallet Issue', 'Blocked by Wallet Office', 'Others'];
function normalizeMainReason(raw: string): MainReason {
  const trimmed = raw.trim();
  const match = MAIN_REASON_VALUES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return match ?? '';
}

const CLOSURE_TYPE_VALUES: ClosureType[] = ['Temporary Close', 'Permanent Close'];
function normalizeClosureType(raw: string): ClosureType {
  const trimmed = raw.trim();
  const match = CLOSURE_TYPE_VALUES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return match ?? '';
}

const AFFECTED_SERVICE_VALUES: AffectedService[] = ['Deposit', 'Withdrawal'];
// Stored as a comma-joined cell (e.g. "Deposit,Withdrawal") — there's no
// natural single-column encoding for a small multi-select, and this is
// simplest to read/write/eyeball directly in the sheet.
function normalizeAffectedServices(raw: string): AffectedService[] {
  return raw.split(',').map((s) => s.trim()).filter((s): s is AffectedService => AFFECTED_SERVICE_VALUES.includes(s as AffectedService));
}

const SCHEDULE_OVERRIDE_VALUES: ScheduleOverride[] = ['Day', 'Extended', 'Early Ext.', '24/7'];
function normalizeScheduleOverride(raw: string): ScheduleOverride {
  const trimmed = raw.trim();
  const match = SCHEDULE_OVERRIDE_VALUES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return match ?? '';
}

// Shared by Minimum Amount Can Take and Balance Limit Override — both are
// "blank = unset" numeric cells.
function normalizeAmountOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  return isNaN(num) ? null : num;
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

// Wallet Settings overrides (Main Reason / Closure Type / Affected
// Services / Minimum Amount Can Take / Balance Limit / Schedule) — same
// sparse-map-by-shop-name pattern as readWalletRemarks below, own
// independent block/row set per product. Column order: Shop Name, Main
// Reason, Closure Type, Affected Services, Minimum Amount Can Take,
// Balance Limit Override, Schedule Override.
async function readWalletOverrides(startCol: string, endCol: string): Promise<Map<string, WalletOverrideEntry>> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${startCol}2:${endCol}20000`);
  } catch {
    return new Map();
  }

  const entries = new Map<string, WalletOverrideEntry>();
  rows.forEach((row) => {
    const shopName = (row[0] ?? '').trim();
    if (!shopName) return;
    entries.set(shopName.toUpperCase(), {
      mainReason: normalizeMainReason(row[1] ?? ''),
      closureType: normalizeClosureType(row[2] ?? ''),
      affectedServices: normalizeAffectedServices(row[3] ?? ''),
      minimumAmountCanTake: normalizeAmountOrNull(row[4] ?? ''),
      balanceLimitOverride: normalizeAmountOrNull(row[5] ?? ''),
      scheduleOverride: normalizeScheduleOverride(row[6] ?? ''),
    });
  });

  return entries;
}

export async function readCashoutWalletOverrides(): Promise<Map<string, WalletOverrideEntry>> {
  return readWalletOverrides(CASHOUT_OVERRIDES_START_COL, CASHOUT_OVERRIDES_END_COL);
}

export async function readSendMoneyWalletOverrides(): Promise<Map<string, WalletOverrideEntry>> {
  return readWalletOverrides(SENDMONEY_OVERRIDES_START_COL, SENDMONEY_OVERRIDES_END_COL);
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

// Cashout-only override fields are optional and independently toggled in
// the Wallet Settings modal's bulk mode — undefined means "don't touch",
// distinct from '' / null which are explicit clears.
export type WalletStatusBulkUpdate = {
  shopName: string;
  priority?: Priority;
  remark?: string;
  mainReason?: MainReason;
  closureType?: ClosureType;
  affectedServices?: AffectedService[];
  minimumAmountCanTake?: number | null;
  balanceLimitOverride?: number | null;
  scheduleOverride?: ScheduleOverride;
};

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
//
async function updateWalletStatusBulk(
  statusStartCol: string,
  statusEndCol: string,
  remarksStartCol: string,
  remarksEndCol: string,
  updates: WalletStatusBulkUpdate[],
  overridesStartCol: string,
  overridesEndCol: string
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

  // Overrides — each of the 6 fields is independently toggled in bulk mode
  // (`undefined` = "don't touch this field"), unlike Remarks above where
  // enabling the field always means writing all 3 remark cells together.
  // Reads the existing row (if any) so untouched fields are carried over
  // as-is rather than blanked out by this write.
  const overrideUpdates = updates.filter((u) =>
    u.mainReason !== undefined || u.closureType !== undefined || u.affectedServices !== undefined
    || u.minimumAmountCanTake !== undefined || u.balanceLimitOverride !== undefined || u.scheduleOverride !== undefined
  );
  if (overrideUpdates.length > 0 && overridesStartCol && overridesEndCol) {
    await ensureOverridesHeader(sheetsApi, spreadsheetId, overridesStartCol, overridesEndCol);
    const rows = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!${overridesStartCol}2:${overridesEndCol}20000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const existingRows = rows.data.values ?? [];
    let nextNewRow = existingRows.length + 2;
    for (const u of overrideUpdates) {
      const normalizedShop = u.shopName.trim().toUpperCase();
      const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);
      const existing = rowOffset !== -1 ? existingRows[rowOffset] : undefined;
      const sheetRow = rowOffset !== -1 ? rowOffset + 2 : nextNewRow++;
      const mainReason = u.mainReason !== undefined ? u.mainReason : normalizeMainReason(existing?.[1] ?? '');
      const closureType = u.closureType !== undefined ? u.closureType : normalizeClosureType(existing?.[2] ?? '');
      const affectedServices = u.affectedServices !== undefined ? u.affectedServices : normalizeAffectedServices(existing?.[3] ?? '');
      const minimumAmountCanTake = u.minimumAmountCanTake !== undefined ? u.minimumAmountCanTake : normalizeAmountOrNull(existing?.[4] ?? '');
      const balanceLimitOverride = u.balanceLimitOverride !== undefined ? u.balanceLimitOverride : normalizeAmountOrNull(existing?.[5] ?? '');
      const scheduleOverride = u.scheduleOverride !== undefined ? u.scheduleOverride : normalizeScheduleOverride(existing?.[6] ?? '');
      const newRow = [
        u.shopName, mainReason, closureType, affectedServices.join(','),
        minimumAmountCanTake === null ? '' : String(minimumAmountCanTake),
        balanceLimitOverride === null ? '' : String(balanceLimitOverride),
        scheduleOverride,
      ];
      data.push({ range: `${SHEET_TITLE}!${overridesStartCol}${sheetRow}:${overridesEndCol}${sheetRow}`, values: [newRow] });
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
  return updateWalletStatusBulk(
    CASHOUT_START_COL, CASHOUT_END_COL, CASHOUT_REMARKS_START_COL, CASHOUT_REMARKS_END_COL, updates,
    CASHOUT_OVERRIDES_START_COL, CASHOUT_OVERRIDES_END_COL
  );
}

export async function updateSendMoneyWalletStatusBulk(updates: WalletStatusBulkUpdate[]): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletStatusBulk(
    SENDMONEY_START_COL, SENDMONEY_END_COL, SENDMONEY_REMARKS_START_COL, SENDMONEY_REMARKS_END_COL, updates,
    SENDMONEY_OVERRIDES_START_COL, SENDMONEY_OVERRIDES_END_COL
  );
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

// Same idempotent-overwrite reasoning as ensureRemarksHeader above.
async function ensureOverridesHeader(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  startCol: string,
  endCol: string
): Promise<void> {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${startCol}1:${endCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Shop Name', 'Main Reason', 'Closure Type', 'Affected Services', 'Minimum Amount Can Take', 'Balance Limit Override', 'Schedule Override']] },
  });
}

// Priority is NOT part of this — the modal no longer edits it (dropped per
// the actual design reference), so this only ever touches the Remarks and
// Overrides blocks now.
export type WalletSettingsUpdate = {
  remark: string;
  mainReason: MainReason;
  closureType: ClosureType;
  affectedServices: AffectedService[];
  minimumAmountCanTake: number | null;
  balanceLimitOverride: number | null;
  scheduleOverride: ScheduleOverride;
};

// Single-wallet save for the unified Edit Wallet Settings modal — reads
// each of the 2 blocks a wallet's settings live in (remarks, overrides)
// ONCE, then writes every row in ONE values.batchUpdate, same "read
// snapshot once, write once" reasoning as updateWalletStatusBulk above,
// just for one shop's full settings instead of N shops' Priority/Remark.
async function updateWalletSettings(
  remarksStartCol: string,
  remarksEndCol: string,
  overridesStartCol: string,
  overridesEndCol: string,
  shopName: string,
  update: WalletSettingsUpdate
): Promise<{ updatedBy: string; updatedAt: string }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);
  await ensureRemarksHeader(sheetsApi, spreadsheetId, remarksStartCol, remarksEndCol);
  await ensureOverridesHeader(sheetsApi, spreadsheetId, overridesStartCol, overridesEndCol);

  const normalizedShop = shopName.trim().toUpperCase();
  const updatedBy = REMARK_UPDATED_BY;
  const updatedAt = new Date().toISOString();
  const data: { range: string; values: string[][] }[] = [];

  // Remarks block.
  {
    const rows = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!${remarksStartCol}2:${remarksEndCol}20000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const existingRows = rows.data.values ?? [];
    const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);
    const sheetRow = rowOffset !== -1 ? rowOffset + 2 : existingRows.length + 2;
    data.push({ range: `${SHEET_TITLE}!${remarksStartCol}${sheetRow}:${remarksEndCol}${sheetRow}`, values: [[shopName, update.remark, updatedBy, updatedAt]] });
  }

  // Overrides block.
  {
    const rows = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!${overridesStartCol}2:${overridesEndCol}20000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const existingRows = rows.data.values ?? [];
    const rowOffset = existingRows.findIndex((row) => String(row[0] ?? '').trim().toUpperCase() === normalizedShop);
    const sheetRow = rowOffset !== -1 ? rowOffset + 2 : existingRows.length + 2;
    const newRow = [
      shopName, update.mainReason, update.closureType, update.affectedServices.join(','),
      update.minimumAmountCanTake === null ? '' : String(update.minimumAmountCanTake),
      update.balanceLimitOverride === null ? '' : String(update.balanceLimitOverride),
      update.scheduleOverride,
    ];
    data.push({ range: `${SHEET_TITLE}!${overridesStartCol}${sheetRow}:${overridesEndCol}${sheetRow}`, values: [newRow] });
  }

  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });

  return { updatedBy, updatedAt };
}

export async function updateCashoutWalletSettings(shopName: string, update: WalletSettingsUpdate): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletSettings(CASHOUT_REMARKS_START_COL, CASHOUT_REMARKS_END_COL, CASHOUT_OVERRIDES_START_COL, CASHOUT_OVERRIDES_END_COL, shopName, update);
}

export async function updateSendMoneyWalletSettings(shopName: string, update: WalletSettingsUpdate): Promise<{ updatedBy: string; updatedAt: string }> {
  return updateWalletSettings(SENDMONEY_REMARKS_START_COL, SENDMONEY_REMARKS_END_COL, SENDMONEY_OVERRIDES_START_COL, SENDMONEY_OVERRIDES_END_COL, shopName, update);
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

export type MergedWalletSettingsEntry = WalletStatusEntry & WalletRemarkEntry & WalletOverrideEntry;

// Combines the three independent maps into one per-shop object — additive
// merge over the union of shop keys, so a shop present in only one side
// still gets the other sides' defaults instead of being dropped. Shared by
// both Cashout's and Send Money's /api/wallet-status GET routes — both
// products now have all 3 blocks (status/remarks/overrides), fully
// separated in their own column ranges (see the column layout comment at
// the top of this file).
export function mergeWalletStatusRemarksAndOverrides(
  status: Map<string, WalletStatusEntry>,
  remarks: Map<string, WalletRemarkEntry>,
  overrides: Map<string, WalletOverrideEntry>
): Record<string, MergedWalletSettingsEntry> {
  const merged: Record<string, MergedWalletSettingsEntry> = {};
  const keys = new Set([...status.keys(), ...remarks.keys(), ...overrides.keys()]);
  keys.forEach((key) => {
    merged[key] = {
      ...DEFAULT_WALLET_STATUS_ENTRY,
      ...(status.get(key) ?? {}),
      ...DEFAULT_WALLET_REMARK_ENTRY,
      ...(remarks.get(key) ?? {}),
      ...DEFAULT_WALLET_OVERRIDE_ENTRY,
      ...(overrides.get(key) ?? {}),
    };
  });
  return merged;
}
