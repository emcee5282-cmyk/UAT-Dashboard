// "Delete Selected" on the record pages (Settlement / Top Up / Opening, both
// products). Reuses each page's existing single-row DELETE endpoint one row
// at a time — same server-side permission check (page.<id>.delete) and
// same delete logic as the row menu's Delete, no new API. Keeps going past
// a failed row so one bad row doesn't strand the rest, then reports.
export async function deleteRowsOneByOne<T>(rows: T[], deleteOne: (row: T) => Promise<Response>): Promise<void> {
  let failed = 0;
  let firstError = '';
  for (const row of rows) {
    try {
      const res = await deleteOne(row);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Request failed with status ${res.status}`);
      }
    } catch (err) {
      failed += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
    }
  }
  if (failed > 0) {
    throw new Error(`Deleted ${rows.length - failed} of ${rows.length}. ${failed} failed: ${firstError}`);
  }
}

export function deleteJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
