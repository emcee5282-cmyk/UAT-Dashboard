import { google, Auth } from 'googleapis';
import { fetchRange } from './googleSheets';

// "Transfer Queue Configurations" — a dedicated sheet tab holding DRAFT
// threshold values for a future Transfer Queue migration. Per explicit
// instruction, this is config-only: nothing in app/transfer-queue/page.tsx,
// app/sendmoney/transfer-queue/page.tsx, or app/lib/transferQueueCount.ts
// (the real, currently-hardcoded queue logic) reads from this tab. This
// module only stores and returns values for the Configurations UI to
// display/edit.
//
// Unlike every other sheet-backed feature in this app (Wallet Status,
// Estimated Opening — sparse, grow-by-append), this row set is 100% FIXED
// and bootstrapped once: exactly 20 rule rows (4 cashout_day + 5
// cashout_extended + 5 cashout_247 + 4 sendmoney_247 + 2 sendmoney_bd) and
// 3 Bundle rows, in a known, unchanging order. That means an update never
// needs to scan for a matching row — the row's position IS its identity
// (sheet row `2 + index`, header on row 1) — simpler and more robust than
// a find-by-value scan, since the very field an admin might rename
// (Queue Result) can't double as a lookup key.
const SHEET_TITLE = 'Transfer Queue Configurations';

const RULES_START_COL = 'A';
const RULES_END_COL = 'I';
// One blank column (J) separates the two blocks, same convention as
// app/lib/estimatedOpening.ts's own block spacing.
const BUNDLE_START_COL = 'K';
const BUNDLE_END_COL = 'N';

export type RuleSection = 'cashout_day' | 'cashout_extended' | 'cashout_247' | 'sendmoney_247' | 'sendmoney_bd';
// Plain-word form, not symbols (">"/"<=") — per explicit instruction, so
// staff reading either the UI or the raw sheet cell understand it
// immediately without decoding shorthand. Stored in the sheet as this
// same word text, not a symbol/code, for the same reason.
export type Operator = 'Greater Than' | 'Greater Than or Equal' | 'Less Than' | 'Less Than or Equal' | 'Between' | 'Equal';
export type Metric = 'SDP VS Balance' | 'Discrepancy' | 'Company Balance';

export type RuleRow = {
  section: RuleSection;
  metric: Metric;
  operator: Operator;
  value1: number;
  value2: number | null;
  queueResult: string;
  // Per explicit instruction: lets an admin mark a row "don't apply this"
  // without needing a real Value/Queue Result — distinct from leaving
  // Value at 0/Queue Result blank, which was ambiguous (looked unset vs.
  // deliberately off). Still config-only either way; this only matters
  // once a future migration starts reading this table live.
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
};

export type BundleFieldName = 'Excluded Brands' | 'Bundle Enabled' | 'Auto Grouping';

export type BundleField = {
  field: BundleFieldName;
  value: string;
  updatedBy: string;
  updatedAt: string;
};

// The real, currently-hardcoded values in app/lib/transferQueueCount.ts,
// used only as bootstrap defaults here — confirmed by reading that file in
// full. cashout_extended and cashout_247 share the same real shape/values
// today (M1's own "Day" reuses the generic 4-rule 24/7 template) but are
// independently editable from here on.
const DEFAULT_RULES: Omit<RuleRow, 'updatedBy' | 'updatedAt'>[] = [
  { section: 'cashout_day', metric: 'Company Balance', operator: 'Less Than', value1: 90000, value2: null, queueResult: 'Day DP + WD', enabled: true },
  { section: 'cashout_day', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 30000, value2: null, queueResult: 'Day WD Only', enabled: true },
  { section: 'cashout_day', metric: 'Discrepancy', operator: 'Greater Than', value1: 20000, value2: null, queueResult: 'Day WD Only', enabled: true },
  { section: 'cashout_day', metric: 'Company Balance', operator: 'Greater Than', value1: 90000, value2: null, queueResult: 'Day WD Only', enabled: true },

  { section: 'cashout_extended', metric: 'Company Balance', operator: 'Less Than', value1: 20000, value2: null, queueResult: 'Low Balance DP Only', enabled: true },
  { section: 'cashout_extended', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 180000, queueResult: 'DP + WD', enabled: true },
  { section: 'cashout_extended', metric: 'Company Balance', operator: 'Greater Than', value1: 200000, value2: null, queueResult: 'WD Only', enabled: true },
  { section: 'cashout_extended', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 30000, value2: null, queueResult: 'Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_extended', metric: 'Discrepancy', operator: 'Greater Than', value1: 20000, value2: null, queueResult: 'Discrepancy / Clear Balance', enabled: true },

  { section: 'cashout_247', metric: 'Company Balance', operator: 'Less Than', value1: 20000, value2: null, queueResult: 'Low Balance DP Only', enabled: true },
  { section: 'cashout_247', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 180000, queueResult: 'DP + WD', enabled: true },
  { section: 'cashout_247', metric: 'Company Balance', operator: 'Greater Than', value1: 200000, value2: null, queueResult: 'WD Only', enabled: true },
  { section: 'cashout_247', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 30000, value2: null, queueResult: 'Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_247', metric: 'Discrepancy', operator: 'Greater Than', value1: 20000, value2: null, queueResult: 'Discrepancy / Clear Balance', enabled: true },

  { section: 'sendmoney_247', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 50000, value2: null, queueResult: '24/7 WD Only', enabled: true },
  { section: 'sendmoney_247', metric: 'Discrepancy', operator: 'Greater Than', value1: 10000, value2: null, queueResult: '24/7 WD Only', enabled: true },
  { section: 'sendmoney_247', metric: 'Company Balance', operator: 'Greater Than', value1: 45000, value2: null, queueResult: '24/7 WD Only', enabled: true },
  { section: 'sendmoney_247', metric: 'Company Balance', operator: 'Less Than', value1: 20000, value2: null, queueResult: '24/7 DP + WD', enabled: true },

  // Per explicit instruction: replaces the old blanket "BD"-wallet-name
  // exclusion (a flat keyword match in the real code, no threshold at
  // all) with an actual configurable limit — Company Balance and SDP vs
  // Company Balance. No real current value exists to bootstrap from (the
  // live rule is a pure keyword match, not a number), so these start
  // blank/zero AND disabled — an admin must both fill in a real value and
  // flip Enabled on before this row means anything.
  { section: 'sendmoney_bd', metric: 'Company Balance', operator: 'Equal', value1: 0, value2: null, queueResult: '', enabled: false },
  { section: 'sendmoney_bd', metric: 'SDP VS Balance', operator: 'Equal', value1: 0, value2: null, queueResult: '', enabled: false },
];

// Forward-looking — no direct current-code equivalent beyond "SH never
// queued"; the other two fields have no live behavior to mirror yet.
const DEFAULT_BUNDLE: Omit<BundleField, 'updatedBy' | 'updatedAt'>[] = [
  { field: 'Excluded Brands', value: 'SH' },
  { field: 'Bundle Enabled', value: 'true' },
  { field: 'Auto Grouping', value: 'true' },
];

const RULES_FIRST_DATA_ROW = 2;
const BUNDLE_FIRST_DATA_ROW = 2;

// No auth system exists in this app — same static label convention as
// app/lib/estimatedOpening.ts's own IMPORTED_BY / app/lib/walletStatus.ts's
// REMARK_UPDATED_BY.
const UPDATED_BY = 'Operations Admin';

// Full read-write scope — separate from app/lib/googleSheets.ts's
// read-only client, same isolated-auth pattern as every other write-capable
// feature in this app.
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

  const now = new Date().toISOString();
  const ruleRows: (string | number)[][] = [
    ['Section', 'Metric', 'Operator', 'Value1', 'Value2', 'Queue Result', 'Enabled', 'Updated By', 'Updated At'],
    ...DEFAULT_RULES.map((r) => [r.section, r.metric, r.operator, r.value1, r.value2 ?? '', r.queueResult, r.enabled ? 'true' : 'false', UPDATED_BY, now]),
  ];
  const bundleRows: (string | number)[][] = [
    ['Field', 'Value', 'Updated By', 'Updated At'],
    ...DEFAULT_BUNDLE.map((b) => [b.field, b.value, UPDATED_BY, now]),
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${RULES_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: ruleRows },
  });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${BUNDLE_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: { values: bundleRows },
  });
}

export const VALID_OPERATORS: Operator[] = ['Greater Than', 'Greater Than or Equal', 'Less Than', 'Less Than or Equal', 'Between', 'Equal'];

function parseOperator(raw: string): Operator {
  const trimmed = raw.trim();
  return (VALID_OPERATORS as string[]).includes(trimmed) ? (trimmed as Operator) : 'Equal';
}

function parseNumber(val: string | number | undefined): number {
  if (typeof val === 'number') return val;
  const cleaned = String(val ?? '').replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export async function readTransferQueueRules(): Promise<RuleRow[]> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${RULES_START_COL}${RULES_FIRST_DATA_ROW}:${RULES_END_COL}${RULES_FIRST_DATA_ROW + DEFAULT_RULES.length}`);
  } catch {
    // Sheet/tab doesn't exist yet — return the real bootstrap defaults
    // directly so the page still shows accurate current-logic values
    // before anyone has ever saved (no blank Updated By/At either, since
    // nothing's been saved yet — using the same "now" isn't right, so
    // these show as never-updated).
    return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));
  }

  if (rows.length === 0) return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));

  return rows.map((row, i) => {
    const fallback = DEFAULT_RULES[i];
    const value2Raw = (row[4] ?? '').trim();
    const enabledRaw = (row[6] ?? '').trim();
    return {
      section: (row[0]?.trim() as RuleSection) || fallback.section,
      metric: (row[1]?.trim() as Metric) || fallback.metric,
      operator: parseOperator(row[2] ?? fallback.operator),
      value1: row[3] !== undefined && row[3] !== '' ? parseNumber(row[3]) : fallback.value1,
      value2: value2Raw ? parseNumber(value2Raw) : null,
      queueResult: (row[5] ?? '').trim() || fallback.queueResult,
      enabled: enabledRaw ? enabledRaw.toLowerCase() === 'true' : fallback.enabled,
      updatedBy: (row[7] ?? '').trim(),
      updatedAt: (row[8] ?? '').trim(),
    };
  });
}

export async function readBundleConfig(): Promise<BundleField[]> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${BUNDLE_START_COL}${BUNDLE_FIRST_DATA_ROW}:${BUNDLE_END_COL}${BUNDLE_FIRST_DATA_ROW + DEFAULT_BUNDLE.length}`);
  } catch {
    return DEFAULT_BUNDLE.map((b) => ({ ...b, updatedBy: '', updatedAt: '' }));
  }

  if (rows.length === 0) return DEFAULT_BUNDLE.map((b) => ({ ...b, updatedBy: '', updatedAt: '' }));

  return rows.map((row, i) => {
    const fallback = DEFAULT_BUNDLE[i];
    return {
      field: (row[0]?.trim() as BundleFieldName) || fallback.field,
      value: (row[1] ?? '').trim() || fallback.value,
      updatedBy: (row[2] ?? '').trim(),
      updatedAt: (row[3] ?? '').trim(),
    };
  });
}

// Updates exactly one rule row by its fixed position (see module comment on
// why an index, not a value-based key, is the right identity here — Queue
// Result itself is editable, so it can't double as a lookup key). `index`
// is 0-based into the full, flat DEFAULT_RULES-ordered list (same order
// readTransferQueueRules returns).
export async function updateTransferQueueRule(
  index: number,
  operator: Operator,
  value1: number,
  value2: number | null,
  queueResult: string,
  enabled: boolean
): Promise<{ updatedBy: string; updatedAt: string }> {
  if (index < 0 || index >= DEFAULT_RULES.length) throw new Error('Invalid rule index.');

  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const rule = DEFAULT_RULES[index];
  const updatedAt = new Date().toISOString();
  const sheetRow = RULES_FIRST_DATA_ROW + index;

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${RULES_START_COL}${sheetRow}:${RULES_END_COL}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[rule.section, rule.metric, operator, value1, value2 ?? '', queueResult, enabled ? 'true' : 'false', UPDATED_BY, updatedAt]],
    },
  });

  return { updatedBy: UPDATED_BY, updatedAt };
}

export async function updateBundleField(index: number, value: string): Promise<{ updatedBy: string; updatedAt: string }> {
  if (index < 0 || index >= DEFAULT_BUNDLE.length) throw new Error('Invalid bundle field index.');

  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  await ensureSheetExists(sheetsApi, spreadsheetId);

  const field = DEFAULT_BUNDLE[index];
  const updatedAt = new Date().toISOString();
  const sheetRow = BUNDLE_FIRST_DATA_ROW + index;

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${BUNDLE_START_COL}${sheetRow}:${BUNDLE_END_COL}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[field.field, value, UPDATED_BY, updatedAt]],
    },
  });

  return { updatedBy: UPDATED_BY, updatedAt };
}
