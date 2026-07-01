import { google, Auth } from 'googleapis';

const SHEET_NAME = 'SSP AG BalanceLimit';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Cached auth client — re-used across requests in the same server process
let _auth: Auth.JWT | null = null;

function getAuthClient(): Auth.JWT {
  if (_auth) return _auth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // .env files store \n as a literal two-char sequence; unescape it
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

/**
 * Fetch all rows from the "SSP AG BalanceLimit" sheet (or a specific A1 range within it).
 *
 * @param range  Optional A1 range suffix, e.g. "A1:Z" or "A2:M".
 *               Omit to return every cell the sheet contains.
 * @returns      2-D array of strings, rows × columns.
 *               Empty cells are returned as empty strings.
 */
export async function fetchBalanceLimitRows(range?: string): Promise<string[][]> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheets = google.sheets({ version: 'v4', auth });

  const fullRange = range ? `${SHEET_NAME}!${range}` : SHEET_NAME;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) return [];

  // Normalise: ensure every row has the same column count as the header row
  const width = rows[0].length;
  return rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded.map(String);
  });
}

/**
 * Fetch a specific named range or any range from any sheet in the same spreadsheet.
 * Lower-level escape hatch for one-off queries.
 */
export async function fetchRange(fullRange: string): Promise<string[][]> {
  const auth = getAuthClient();
  const spreadsheetId = getSpreadsheetId();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) return [];

  const width = rows[0].length;
  return rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded.map(String);
  });
}

/**
 * Convert string[][] from the Sheets API back to a CSV string so existing
 * client-side parseCsvLines() calls keep working without any changes.
 */
export function toCSV(rows: string[][]): string {
  return rows.map((row) =>
    row.map((cell) => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    }).join(',')
  ).join('\n');
}
