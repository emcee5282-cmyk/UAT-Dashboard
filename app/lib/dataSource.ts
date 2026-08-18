// Local-only data-source switch — NOT consumed by any existing page or API
// route yet (every current route still hardcodes Google Sheets as its
// source, unchanged). Exists so a future, explicit per-route cutover can
// check this instead of each inventing its own env-var check, and so this
// phase leaves a documented, working mechanism behind rather than just a
// plan. Defaults to 'google_sheets' unconditionally if the env var is
// missing or holds anything else — production must never silently start
// reading Postgres because of a typo or unset variable.
export type DataSource = 'google_sheets' | 'postgres';

export function getDataSource(): DataSource {
  return process.env.DATA_SOURCE === 'postgres' ? 'postgres' : 'google_sheets';
}

export function isPostgresSource(): boolean {
  return getDataSource() === 'postgres';
}
