// Read the RAW cell text directly, bypassing mapOpeningRows' own
// normalizeOpeningAgentName() step, to see what's actually typed in the
// file before any brand/suffix stripping happens.
import fs from 'fs';
import * as XLSX from 'xlsx';

const FILE_PATH = 'c:\\Users\\ejboy\\Desktop\\dashbaord_project\\opening-cashout-template (4).xlsx';

async function main() {
  const buffer = fs.readFileSync(FILE_PATH);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const allRows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });

  console.log('Header row (row 1):', allRows[0]);
  console.log('\n--- Rows around AVENT001 (file rows 3, 179-181 => array index 2, 178-180) ---');
  [2, 178, 179, 180].forEach((idx) => console.log(`array[${idx}] (file row ${idx + 1}):`, allRows[idx]));

  console.log('\n--- Rows around SANGE002/003/005/006 (file rows 3359-3368 => array index 3358-3367) ---');
  for (let idx = 3358; idx <= 3367; idx++) {
    console.log(`array[${idx}] (file row ${idx + 1}):`, allRows[idx]);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
