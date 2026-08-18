import { readFileSync } from 'fs';
import { Pool } from 'pg';
import * as XLSX from 'xlsx';

function loadEnvLocal(path: string): void {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadEnvLocal('c:/Users/ejboy/Desktop/dashbaord_project/.env.local');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Only shops where BOTH opening_balance and sdp are already non-null real
  // values -- re-writing the exact same value back is then truly a no-op,
  // avoiding any null-to-explicit-zero collapse for Send Money's documented
  // nullable Opening Bal/SDP data model.
  const { rows } = await pool.query(`
    select a.agent_code, l.name as leader, a.opening_balance, a.sdp
    from agents a
    left join leaders l on l.id = a.leader_id
    where a.product = 'sendmoney' and a.opening_balance is not null and a.sdp is not null
  `);
  console.log(`Eligible real sendmoney agents (non-null opening_balance/sdp): ${rows.length}`);

  const header = ['Agent Name', 'Leader', 'Opening Bal.', 'SDP'];
  const dataRows = rows.map((r) => [r.agent_code, r.leader ?? '', r.opening_balance, r.sdp]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const outPath = 'c:/Users/ejboy/Desktop/dashbaord_project/.playwright-mcp/sendmoney-content-neutral.xlsx';
  XLSX.writeFile(wb, outPath);
  console.log(`Written ${dataRows.length} rows to ${outPath}`);

  // Save a small verification snapshot (agent_code -> current values) so we
  // can confirm nothing actually changed after the real import.
  const snapshot = rows.slice(0, 15).map((r) => ({ agent_code: r.agent_code, opening_balance: r.opening_balance, sdp: r.sdp }));
  console.log('Snapshot sample (first 15) for post-import comparison:', JSON.stringify(snapshot, null, 2));

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
