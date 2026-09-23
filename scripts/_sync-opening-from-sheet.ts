// Pulls the CURRENT "Opening AG" tab (live, no history — same data the real
// Upload button would read if someone exported it right now) and runs it
// through the REAL importOpeningFile() pipeline — same ghost-reconciliation,
// family-leader-inheritance, and opening_wallet_lines writes the live
// Upload button gets, not a raw upsert. Built because the user asked to
// "update the opening" so recently-referenced-but-missing shops (JOKER001,
// MAKI008, JEAN006, MOONSTONE005, etc. — surfaced as "no matching agent"
// rejects during the Settlement/TopUp backfill) get picked up.
import * as XLSX from 'xlsx';
import { fetchRange } from '../app/lib/googleSheets';
import { importOpeningFile, type Product } from '../app/lib/services/importService';

function buildXlsxFile(headers: string[], rows: string[][], fileName: string): File {
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new File([new Uint8Array(buffer)], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function syncProduct(product: Product) {
  const range = product === 'cashout' ? 'Opening AG!A2:D' : 'Opening AG!L2:O';
  const headers = product === 'cashout'
    ? ['Agent name', 'Opening Bal.', 'SDP', 'Leader']
    : ['Wallet Name', 'Opening Bal.', 'SDP', 'TL'];
  const rows = await fetchRange(range);
  // Drop fully-blank rows so the parser's own "nothing here" skip doesn't
  // have to wade through thousands of empty trailing rows.
  const nonBlank = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  console.log(`${product}: ${nonBlank.length} non-blank rows from ${range}`);

  const file = buildXlsxFile(headers, nonBlank, `opening-ag-sync-${product}.xlsx`);
  const result = await importOpeningFile({
    product,
    file,
    fileName: file.name,
    uploadedBy: 'Sheets sync (assistant)',
  });
  console.log(`${product} import result:`, result);
}

async function main() {
  await syncProduct('cashout');
  await syncProduct('sendmoney');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
