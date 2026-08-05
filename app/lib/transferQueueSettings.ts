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
// and bootstrapped once: exactly 34 rule rows (4 cashout_day + 5
// cashout_extended + 5 cashout_247 + 5 cashout_sh_day + 2
// cashout_sh_early_extended + 2 cashout_sh_extended + 5 cashout_sh_247 + 4
// sendmoney_247 + 2 sendmoney_bd) and 3 Bundle rows, in a known, unchanging
// order. That means an update never needs to scan for a matching row — the
// row's position IS its identity (sheet row `2 + index`, header on row 1)
// — simpler and more robust than a find-by-value scan, since the very
// field an admin might rename (Queue Result) can't double as a lookup key.
// Row COUNT has changed once already (20 -> 34, when the SH-based sections
// were added) — see migrateRulesSchemaIfNeeded() below for how that's
// handled safely without losing any section's saved values.
const SHEET_TITLE = 'Transfer Queue Configurations';
// Separate append-only tab (grows on every save) — the fixed-position model the Rules/
// Bundle/Meta blocks use can't hold history without overwriting it.
const HISTORY_SHEET_TITLE = 'Transfer Queue Rule History';

const RULES_START_COL = 'A';
const RULES_END_COL = 'I';
// One blank column (J) separates each block, same convention as
// app/lib/estimatedOpening.ts's own block spacing.
const BUNDLE_START_COL = 'K';
const BUNDLE_END_COL = 'N';
const META_START_COL = 'P';
const META_END_COL = 'S';

// cashout_day/cashout_extended/cashout_247 are the REAL, LIVE sections —
// app/lib/transferQueueRules.ts's resolveCashoutCorrectGroup() reads these
// three by exact string match and is actually called from
// app/transfer-queue/page.tsx to assign real shops to real queue groups.
// Never rename/remove/reorder-within-section these three; the SH-based
// sections added alongside them (cashout_sh_*) are a separate, currently
// admin-only draft per explicit instruction — nothing reads those yet.
export type RuleSection =
  | 'cashout_day' | 'cashout_extended' | 'cashout_247'
  | 'cashout_sh_day' | 'cashout_sh_early_extended' | 'cashout_sh_extended' | 'cashout_sh_247'
  | 'sendmoney_247' | 'sendmoney_bd';
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

// 'production' = ignore the sheet entirely, always evaluate against DEFAULT_RULES (the
// real hardcoded values) — the instant-rollback kill-switch. 'configuration' = use
// whatever's actually saved. Lives in the sheet (not an env var) specifically so
// flipping it takes effect without a redeploy.
export type TransferQueueMode = 'production' | 'configuration';
export type MetaFieldName = 'Mode' | 'Version';

export type MetaField = {
  field: MetaFieldName;
  value: string;
  updatedBy: string;
  updatedAt: string;
};

export type RuleHistoryEntry = {
  timestamp: string;
  section: RuleSection;
  metric: Metric;
  oldOperator: Operator;
  oldValue1: number;
  oldValue2: number | null;
  oldQueueResult: string;
  newOperator: Operator;
  newValue1: number;
  newValue2: number | null;
  newQueueResult: string;
  updatedBy: string;
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

  // SH-based sections — one shared configuration applied to every Cashout
  // shop based on its schedule, replacing the old per-brand model above for
  // admin-editing purposes. Per explicit instruction: draft only for now,
  // NOT read by app/lib/transferQueueRules.ts or the live Transfer Queue —
  // the three sections above stay the real evaluation source until a
  // future migration wires these in.
  { section: 'cashout_sh_day', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 30000, value2: null, queueResult: 'SH-Day Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_sh_day', metric: 'Discrepancy', operator: 'Greater Than', value1: 20000, value2: null, queueResult: 'SH-Day Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_sh_day', metric: 'Company Balance', operator: 'Less Than', value1: 15000, value2: null, queueResult: 'SH-Day DP Only', enabled: true },
  { section: 'cashout_sh_day', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 140000, queueResult: 'SH-Day DP + WD', enabled: true },
  { section: 'cashout_sh_day', metric: 'Company Balance', operator: 'Greater Than', value1: 150000, value2: null, queueResult: 'SH-Day WD Only', enabled: true },

  { section: 'cashout_sh_early_extended', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 140000, queueResult: 'SH-Early Day DP + WD', enabled: true },
  { section: 'cashout_sh_early_extended', metric: 'Company Balance', operator: 'Greater Than', value1: 150000, value2: null, queueResult: 'SH-Early Day WD Only', enabled: true },

  { section: 'cashout_sh_extended', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 140000, queueResult: 'SH-Extended Day DP + WD', enabled: true },
  { section: 'cashout_sh_extended', metric: 'Company Balance', operator: 'Greater Than', value1: 150000, value2: null, queueResult: 'SH-Extended Day WD Only', enabled: true },

  { section: 'cashout_sh_247', metric: 'SDP VS Balance', operator: 'Greater Than', value1: 30000, value2: null, queueResult: 'SH-24/7 Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_sh_247', metric: 'Discrepancy', operator: 'Greater Than', value1: 20000, value2: null, queueResult: 'SH-24/7 Discrepancy / Clear Balance', enabled: true },
  { section: 'cashout_sh_247', metric: 'Company Balance', operator: 'Less Than', value1: 15000, value2: null, queueResult: 'SH-24/7 DP Only', enabled: true },
  { section: 'cashout_sh_247', metric: 'Company Balance', operator: 'Between', value1: 35000, value2: 190000, queueResult: 'SH-24/7 DP + WD', enabled: true },
  { section: 'cashout_sh_247', metric: 'Company Balance', operator: 'Greater Than', value1: 200000, value2: null, queueResult: 'SH-24/7 WD Only', enabled: true },

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

// Defaults to 'configuration' — today's DEFAULT_RULES already reproduce production
// behavior exactly, so there's nothing to "roll back from" until an admin actually
// changes a value; flipping to 'production' is the emergency kill-switch from then on.
const DEFAULT_META: Omit<MetaField, 'updatedBy' | 'updatedAt'>[] = [
  { field: 'Mode', value: 'configuration' },
  { field: 'Version', value: '1' },
];

const RULES_FIRST_DATA_ROW = 2;
const BUNDLE_FIRST_DATA_ROW = 2;
const META_FIRST_DATA_ROW = 2;
const HISTORY_FIRST_DATA_ROW = 2;
const HISTORY_START_COL = 'A';
const HISTORY_END_COL = 'L';

const RULES_CACHE_TTL_MS = 60_000;
let _rulesCache: { rules: RuleRow[]; expiresAt: number } | null = null;

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

// Wide enough for every current + reasonably foreseeable block (Rules end at I,
// Bundle at N, Meta at S) with headroom — explicit, so a fresh tab is never left at
// whatever narrower default the Sheets API happens to pick.
const SHEET_MIN_COLUMN_COUNT = 26;

async function ensureSheetExists(sheetsApi: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === SHEET_TITLE);
  const now = new Date().toISOString();

  if (!sheet) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: SHEET_TITLE, gridProperties: { columnCount: SHEET_MIN_COLUMN_COUNT } },
          },
        }],
      },
    });

    const ruleRows: (string | number)[][] = [
      ['Section', 'Metric', 'Operator', 'Value1', 'Value2', 'Queue Result', 'Enabled', 'Updated By', 'Updated At'],
      ...DEFAULT_RULES.map((r) => [r.section, r.metric, r.operator, r.value1, r.value2 ?? '', r.queueResult, r.enabled ? 'true' : 'false', UPDATED_BY, now]),
    ];
    const bundleRows: (string | number)[][] = [
      ['Field', 'Value', 'Updated By', 'Updated At'],
      ...DEFAULT_BUNDLE.map((b) => [b.field, b.value, UPDATED_BY, now]),
    ];
    const metaRows: (string | number)[][] = [
      ['Field', 'Value', 'Updated By', 'Updated At'],
      ...DEFAULT_META.map((m) => [m.field, m.value, UPDATED_BY, now]),
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
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!${META_START_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: metaRows },
    });
    return;
  }

  // Tab already existed from before the Meta block (Mode/Version) was introduced —
  // its grid may be too narrow to reach column P:S, and the Meta block itself was
  // never bootstrapped (the early-return above used to skip it entirely for an
  // already-existing tab). Backfill both, without touching the Rules/Bundle blocks
  // that already have real saved data.
  const sheetId = sheet.properties?.sheetId;
  const currentColumnCount = sheet.properties?.gridProperties?.columnCount ?? 0;
  if (sheetId !== undefined && sheetId !== null && currentColumnCount < SHEET_MIN_COLUMN_COUNT) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { columnCount: SHEET_MIN_COLUMN_COUNT } },
            fields: 'gridProperties.columnCount',
          },
        }],
      },
    });
  }

  let metaHeaderExists = false;
  try {
    const existingMetaRows = await fetchRange(`${SHEET_TITLE}!${META_START_COL}1:${META_END_COL}1`);
    metaHeaderExists = existingMetaRows.length > 0 && existingMetaRows[0]?.[0]?.trim() === 'Field';
  } catch {
    metaHeaderExists = false;
  }

  if (!metaHeaderExists) {
    const metaRows: (string | number)[][] = [
      ['Field', 'Value', 'Updated By', 'Updated At'],
      ...DEFAULT_META.map((m) => [m.field, m.value, UPDATED_BY, now]),
    ];
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!${META_START_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: metaRows },
    });
  }
}

async function ensureHistorySheetExists(sheetsApi: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === HISTORY_SHEET_TITLE);
  if (exists) return;

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: HISTORY_SHEET_TITLE } } }],
    },
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${HISTORY_SHEET_TITLE}!${HISTORY_START_COL}1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Timestamp', 'Section', 'Metric', 'Old Operator', 'Old Value1', 'Old Value2', 'Old Queue Result',
        'New Operator', 'New Value1', 'New Value2', 'New Queue Result', 'Updated By',
      ]],
    },
  });
}

async function appendRuleHistory(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  entry: RuleHistoryEntry
): Promise<void> {
  await ensureHistorySheetExists(sheetsApi, spreadsheetId);
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId,
    range: `${HISTORY_SHEET_TITLE}!${HISTORY_START_COL}${HISTORY_FIRST_DATA_ROW}:${HISTORY_END_COL}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        entry.timestamp, entry.section, entry.metric,
        entry.oldOperator, entry.oldValue1, entry.oldValue2 ?? '', entry.oldQueueResult,
        entry.newOperator, entry.newValue1, entry.newValue2 ?? '', entry.newQueueResult,
        entry.updatedBy,
      ]],
    },
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

// The Rules block's row COUNT/ORDER changed (20 -> 34) when the SH-based
// sections were added — a sheet saved under the old 20-row layout no
// longer lines up against DEFAULT_RULES by position (e.g. old row 14 was
// sendmoney_247's first row; new row 14 belongs to cashout_sh_day). Every
// section label that existed before is STILL a valid section today
// (cashout_day/extended/247 and sendmoney_247/bd are untouched — only new
// sections were inserted before them), so this reflows the block by each
// row's own stable section label rather than its position: every section's
// saved values (operator/value/queueResult/enabled) are fully preserved,
// only their sheet ROW moves to match the new layout. Brand-new sections
// (cashout_sh_*) have no old data to carry forward and get fresh defaults.
function rowsMatchCurrentSchema(rows: string[][]): boolean {
  if (rows.length < DEFAULT_RULES.length) return false;
  return DEFAULT_RULES.every((rule, i) => (rows[i]?.[0] ?? '').trim() === rule.section);
}

async function migrateRulesSchemaIfNeeded(rows: string[][]): Promise<string[][]> {
  if (rowsMatchCurrentSchema(rows)) return rows;

  const bySection = new Map<string, string[][]>();
  for (const row of rows) {
    const key = (row[0] ?? '').trim();
    if (!key) continue;
    const bucket = bySection.get(key) ?? [];
    bucket.push(row);
    bySection.set(key, bucket);
  }

  const now = new Date().toISOString();
  const newRows: (string | number)[][] = DEFAULT_RULES.map((rule) => {
    const bucket = bySection.get(rule.section);
    const old = bucket?.shift();
    if (old) {
      return [
        rule.section, rule.metric,
        (old[2] ?? '').trim() || rule.operator,
        old[3] !== undefined && old[3] !== '' ? old[3] : rule.value1,
        old[4] ?? '',
        (old[5] ?? '').trim() || rule.queueResult,
        (old[6] ?? '').trim() || (rule.enabled ? 'true' : 'false'),
        old[7] ?? '', old[8] ?? '',
      ];
    }
    return [rule.section, rule.metric, rule.operator, rule.value1, rule.value2 ?? '', rule.queueResult, rule.enabled ? 'true' : 'false', UPDATED_BY, now];
  });

  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  // Clear a generous range first — the old block (20 rows) is shorter than
  // the new one (34), so a plain overwrite would leave no stale rows
  // behind, but clearing first is the same safety margin every other
  // reflow in this codebase uses when a block's shape changes.
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${SHEET_TITLE}!${RULES_START_COL}${RULES_FIRST_DATA_ROW}:${RULES_END_COL}500`,
  });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${RULES_START_COL}${RULES_FIRST_DATA_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });

  return newRows.map((r) => r.map((cell) => String(cell)));
}

async function fetchTransferQueueRulesFromSheet(): Promise<RuleRow[]> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${RULES_START_COL}${RULES_FIRST_DATA_ROW}:${RULES_END_COL}${RULES_FIRST_DATA_ROW + DEFAULT_RULES.length + 20}`);
  } catch {
    // Sheet/tab doesn't exist yet — return the real bootstrap defaults
    // directly so the page still shows accurate current-logic values
    // before anyone has ever saved (no blank Updated By/At either, since
    // nothing's been saved yet — using the same "now" isn't right, so
    // these show as never-updated).
    return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));
  }

  if (rows.length === 0) return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));

  rows = await migrateRulesSchemaIfNeeded(rows);

  return rows.slice(0, DEFAULT_RULES.length).map((row, i) => {
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

// Cached — point 4's "don't read the Sheet on every request." 60s TTL, auto-refetches
// once expired. Writes (updateTransferQueueRule) invalidate this immediately so an
// admin's own Save is never masked by stale cached data.
export async function readTransferQueueRules(): Promise<RuleRow[]> {
  const now = Date.now();
  if (_rulesCache && _rulesCache.expiresAt > now) return _rulesCache.rules;

  const rules = await fetchTransferQueueRulesFromSheet();
  _rulesCache = { rules, expiresAt: now + RULES_CACHE_TTL_MS };
  return rules;
}

function invalidateRulesCache(): void {
  _rulesCache = null;
}

// What the LIVE Transfer Queue consumers use (Cashout/Send Money pages + Sidebar badge)
// — distinct from readTransferQueueRules() above, which the Configuration admin page
// uses so an admin always sees/edits their real saved draft regardless of mode. In
// 'production' mode this returns the hardcoded DEFAULT_RULES untouched, ignoring
// whatever's saved — the instant-rollback kill-switch (point 5).
export async function readEffectiveTransferQueueRules(): Promise<RuleRow[]> {
  const meta = await readMetaConfig();
  if (meta.mode === 'production') {
    return DEFAULT_RULES.map((r) => ({ ...r, updatedBy: '', updatedAt: '' }));
  }
  return readTransferQueueRules();
}

export type MetaConfig = { mode: TransferQueueMode; version: number; updatedBy: string; updatedAt: string };

let _metaCache: { meta: MetaConfig; expiresAt: number } | null = null;

async function fetchMetaConfigFromSheet(): Promise<MetaConfig> {
  let rows: string[][];
  try {
    rows = await fetchRange(`${SHEET_TITLE}!${META_START_COL}${META_FIRST_DATA_ROW}:${META_END_COL}${META_FIRST_DATA_ROW + DEFAULT_META.length}`);
  } catch {
    return { mode: 'configuration', version: 1, updatedBy: '', updatedAt: '' };
  }
  if (rows.length === 0) return { mode: 'configuration', version: 1, updatedBy: '', updatedAt: '' };

  const modeRow = rows.find((r) => (r[0] ?? '').trim() === 'Mode');
  const versionRow = rows.find((r) => (r[0] ?? '').trim() === 'Version');
  const mode: TransferQueueMode = modeRow?.[1]?.trim() === 'production' ? 'production' : 'configuration';
  const version = versionRow ? parseInt(versionRow[1], 10) || 1 : 1;
  const updatedBy = modeRow?.[2]?.trim() || versionRow?.[2]?.trim() || '';
  const updatedAt = [modeRow?.[3]?.trim(), versionRow?.[3]?.trim()].filter(Boolean).sort().pop() ?? '';

  return { mode, version, updatedBy, updatedAt };
}

// Cached alongside the Rules cache — same "don't hit the Sheet every request" reason.
export async function readMetaConfig(): Promise<MetaConfig> {
  const now = Date.now();
  if (_metaCache && _metaCache.expiresAt > now) return _metaCache.meta;

  const metaConfig = await fetchMetaConfigFromSheet();
  _metaCache = { meta: metaConfig, expiresAt: now + RULES_CACHE_TTL_MS };
  return metaConfig;
}

function invalidateMetaCache(): void {
  _metaCache = null;
}

async function writeMetaField(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  index: number,
  value: string,
  updatedAt: string
): Promise<void> {
  const field = DEFAULT_META[index];
  const sheetRow = META_FIRST_DATA_ROW + index;
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!${META_START_COL}${sheetRow}:${META_END_COL}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[field.field, value, UPDATED_BY, updatedAt]] },
  });
}

// The "instant rollback" lever (point 5) — flips the Sheet's Mode cell. Takes effect on
// the next cache refresh (≤60s), no redeploy required.
export async function setTransferQueueMode(mode: TransferQueueMode): Promise<{ updatedBy: string; updatedAt: string }> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheetsApi = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(sheetsApi, spreadsheetId);

  const updatedAt = new Date().toISOString();
  await writeMetaField(sheetsApi, spreadsheetId, 0, mode, updatedAt);
  invalidateMetaCache();
  return { updatedBy: UPDATED_BY, updatedAt };
}

// Reads the current version fresh (not the cache) to avoid racing a concurrent bump,
// then writes version+1. Called on every rule/bundle save (point 6).
async function bumpVersion(sheetsApi: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  let currentVersion = 1;
  try {
    const rows = await fetchRange(`${SHEET_TITLE}!${META_START_COL}${META_FIRST_DATA_ROW}:${META_END_COL}${META_FIRST_DATA_ROW + DEFAULT_META.length}`);
    const versionRow = rows.find((r) => (r[0] ?? '').trim() === 'Version');
    currentVersion = versionRow ? parseInt(versionRow[1], 10) || 1 : 1;
  } catch {
    currentVersion = 1;
  }
  await writeMetaField(sheetsApi, spreadsheetId, 1, String(currentVersion + 1), new Date().toISOString());
  invalidateMetaCache();
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

  // Read the row's current state BEFORE overwriting it, so the audit-history entry
  // (point 8) can capture a real "previous value" — not just the new one.
  const currentRules = await fetchTransferQueueRulesFromSheet();
  const previous = currentRules[index] ?? DEFAULT_RULES[index];

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

  await appendRuleHistory(sheetsApi, spreadsheetId, {
    timestamp: updatedAt,
    section: rule.section,
    metric: rule.metric,
    oldOperator: previous.operator,
    oldValue1: previous.value1,
    oldValue2: previous.value2,
    oldQueueResult: previous.queueResult,
    newOperator: operator,
    newValue1: value1,
    newValue2: value2,
    newQueueResult: queueResult,
    updatedBy: UPDATED_BY,
  });
  await bumpVersion(sheetsApi, spreadsheetId);
  invalidateRulesCache();

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

  await bumpVersion(sheetsApi, spreadsheetId);

  return { updatedBy: UPDATED_BY, updatedAt };
}
